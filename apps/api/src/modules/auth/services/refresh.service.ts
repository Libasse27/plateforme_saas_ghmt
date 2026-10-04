import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthTokens } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { parseOpaqueToken } from '../../../common/auth/opaque-token';
import { evaluateRefresh, type RefreshDecision } from './refresh-policy';
import { SessionService } from './session.service';

type Outcome =
  | { kind: 'ok'; userId: string; sessionId: string; mfa: boolean; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'reuse' };

function invalidRefresh(): DomainError {
  return DomainError.unauthorized('Jeton de rafraîchissement invalide ou expiré.');
}

/** Rotation des refresh tokens avec détection de réutilisation (docs/04 §1.4). */
@Injectable()
export class RefreshService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async refresh(rawToken: string): Promise<AuthTokens> {
    const parsed = parseOpaqueToken(rawToken);
    if (!parsed) throw invalidRefresh();

    // La révocation sur réutilisation doit être validée (commit) : l'erreur est levée après la transaction.
    const outcome = await this.tenantDb.runAs(parsed.tenantId, (tx) => this.rotate(tx, parsed.tenantId, parsed.hash));
    if (outcome.kind !== 'ok') throw invalidRefresh();

    const accessToken = await this.sessions.signAccessToken({
      tenantId: parsed.tenantId,
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      mfa: outcome.mfa,
    });
    return { accessToken, refreshToken: outcome.refreshToken, expiresIn: this.sessions.accessTokenTtlSeconds };
  }

  private async rotate(tx: TenantTx, tenantId: string, tokenHash: Uint8Array<ArrayBuffer>): Promise<Outcome> {
    const now = new Date();
    let current = await this.load(tx, tenantId, tokenHash, now);
    if (!current) return { kind: 'invalid' };

    let replacementId: string | undefined;
    if (current.decision === 'rotate') {
      // Prise atomique du jeton : deux requêtes concurrentes ne peuvent pas toutes deux le consommer.
      replacementId = randomUUID();
      const claimed = await tx.refreshToken.updateMany({
        where: { tenantId, id: current.token.id, usedAt: null },
        data: { usedAt: now, replacedById: replacementId },
      });
      if (claimed.count === 0) {
        replacementId = undefined;
        current = await this.load(tx, tenantId, tokenHash, now);
        if (!current) return { kind: 'invalid' };
      }
    }

    const { token, session, decision } = current;
    if (decision === 'invalid') return { kind: 'invalid' };
    if (decision === 'reuse') {
      await this.revokeFamily(tx, tenantId, token.familyId, session.id, session.userId, now);
      return { kind: 'reuse' };
    }

    const issued = await this.sessions.issueRefreshToken(tx, {
      tenantId,
      sessionId: session.id,
      familyId: token.familyId,
      sessionExpiresAt: session.expiresAt,
      now,
      ...(replacementId ? { id: replacementId } : {}),
    });
    if (decision === 'grace' && token.replacedById) {
      // Jeton de grâce : le remplaçant resté inutilisé est révoqué (chaîné au nouveau), il ne peut plus servir qu'une fois dans la fenêtre.
      await tx.refreshToken.updateMany({
        where: { tenantId, id: token.replacedById, usedAt: null },
        data: { usedAt: now, replacedById: issued.id },
      });
    }
    await tx.session.update({ where: { tenantId_id: { tenantId, id: session.id } }, data: { lastSeenAt: now }, select: { id: true } });
    return { kind: 'ok', userId: session.userId, sessionId: session.id, mfa: session.mfaVerifiedAt !== null, refreshToken: issued.token };
  }

  private async load(tx: TenantTx, tenantId: string, tokenHash: Uint8Array<ArrayBuffer>, now: Date) {
    const token = await tx.refreshToken.findUnique({
      where: { tenantId_tokenHash: { tenantId, tokenHash } },
      include: { session: { include: { user: { select: { status: true, deletedAt: true } } } } },
    });
    if (!token) return undefined;

    const replacement = token.replacedById
      ? await tx.refreshToken.findUnique({ where: { tenantId_id: { tenantId, id: token.replacedById } }, select: { usedAt: true } })
      : null;
    const { session } = token;
    const userActive = session.user.status === 'active' && session.user.deletedAt === null;
    const decision: RefreshDecision = userActive
      ? evaluateRefresh(
          {
            tokenUsedAt: token.usedAt,
            tokenExpiresAt: token.expiresAt,
            replacementUsedAt: replacement ? replacement.usedAt : undefined,
            sessionRevokedAt: session.revokedAt,
            sessionExpiresAt: session.expiresAt,
          },
          now,
        )
      : 'invalid';
    return { token, session, decision };
  }

  private async revokeFamily(tx: TenantTx, tenantId: string, familyId: string, sessionId: string, userId: string, now: Date): Promise<void> {
    await tx.refreshToken.updateMany({ where: { tenantId, familyId, usedAt: null }, data: { usedAt: now } });
    await tx.session.update({
      where: { tenantId_id: { tenantId, id: sessionId } },
      data: { revokedAt: now, revokedReason: 'refresh_reuse_detected' },
      select: { id: true },
    });
    await this.audit.record(tx, tenantId, {
      action: 'auth.refresh.reuse_detected',
      outcome: 'denied',
      actorUserId: userId,
      resourceType: 'session',
      resourceId: sessionId,
      changes: { familyId },
    });
  }
}
