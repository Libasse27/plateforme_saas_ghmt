import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthTokens, PlatformMe, PlatformRole } from '@ghmt/shared';
import { PLATFORM_ROLE_PERMISSIONS } from '@ghmt/shared';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { PlatformDb, type PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { evaluateRefresh, type RefreshDecision } from '../../auth/services/refresh-policy';
import { hashPlatformToken } from './platform-opaque-token';
import type { PlatformPrincipal } from './platform-auth.guard';
import { PlatformSessionsService } from './platform-sessions.service';
import { PlatformTokenService } from './platform-token.service';

type Outcome =
  | { kind: 'ok'; userId: string; sessionId: string; role: PlatformRole; mfa: boolean; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'reuse' };

function invalidRefresh(): DomainError {
  return DomainError.unauthorized('Jeton de rafraîchissement invalide ou expiré.');
}

/** Rotation des refresh tokens plateforme avec détection de réutilisation, déconnexion et profil. */
@Injectable()
export class PlatformRefreshService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly sessions: PlatformSessionsService,
    private readonly tokens: PlatformTokenService,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  async refresh(rawToken: string): Promise<AuthTokens> {
    const hash = hashPlatformToken(rawToken);
    if (!hash) throw invalidRefresh();
    // La révocation sur réutilisation doit être validée (commit) : l'erreur est levée après la transaction.
    const outcome = await this.platformDb.run((tx) => this.rotate(tx, hash, this.clock.now()));
    if (outcome.kind !== 'ok') throw invalidRefresh();
    const accessToken = await this.sessions.signAccessToken(outcome.userId, outcome.sessionId, outcome.role, outcome.mfa);
    return { accessToken, refreshToken: outcome.refreshToken, expiresIn: this.sessions.accessTokenTtlSeconds };
  }

  /** Déconnexion : le jeton de rafraîchissement suffit ; à défaut, le jeton d'accès. Idempotente. */
  async logout(params: { refreshToken?: string; accessToken?: string }): Promise<void> {
    const now = this.clock.now();
    if (params.refreshToken) {
      const hash = hashPlatformToken(params.refreshToken);
      if (!hash) return;
      const token = await this.platformDb.run((tx) =>
        tx.platformRefreshToken.findUnique({ where: { tokenHash: hash }, select: { session: { select: { id: true, userId: true } } } }),
      );
      if (token) await this.revoke(token.session.id, token.session.userId, now);
      return;
    }
    if (!params.accessToken) throw DomainError.unauthorized();
    const claims = await this.tokens.verify(params.accessToken);
    await this.revoke(claims.sessionId, claims.userId, now);
  }

  async me(principal: PlatformPrincipal): Promise<PlatformMe> {
    const user = await this.platformDb.run((tx) => tx.platformUser.findUniqueOrThrow({ where: { id: principal.userId } }));
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      mfaEnrolled: user.mfaActivatedAt !== null,
      mfaVerified: principal.mfa,
      permissions: PLATFORM_ROLE_PERMISSIONS[user.role],
    };
  }

  private revoke(sessionId: string, userId: string, now: Date): Promise<void> {
    return this.platformDb.run(async (tx) => {
      const { count } = await tx.platformSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'logout' },
      });
      if (count === 0) return;
      const user = await tx.platformUser.findUnique({ where: { id: userId }, select: { role: true } });
      await this.audit.record(tx, {
        action: 'platform.auth.logout',
        actor: { type: 'platform_user', userId, role: user?.role ?? 'unknown' },
        resourceType: 'platform_session',
        resourceId: sessionId,
      });
    });
  }

  private async rotate(tx: PlatformTx, tokenHash: Uint8Array<ArrayBuffer>, now: Date): Promise<Outcome> {
    let current = await this.load(tx, tokenHash, now);
    if (!current) return { kind: 'invalid' };

    let replacementId: string | undefined;
    if (current.decision === 'rotate') {
      // Prise atomique du jeton : deux requêtes concurrentes ne peuvent pas toutes deux le consommer.
      replacementId = randomUUID();
      const claimed = await tx.platformRefreshToken.updateMany({
        where: { id: current.token.id, usedAt: null },
        data: { usedAt: now, replacedById: replacementId },
      });
      if (claimed.count === 0) {
        replacementId = undefined;
        current = await this.load(tx, tokenHash, now);
        if (!current) return { kind: 'invalid' };
      }
    }
    const { token, session, decision } = current;
    if (decision === 'invalid') return { kind: 'invalid' };
    if (decision === 'reuse') {
      await this.revokeFamily(tx, token.familyId, session.id, session.userId, session.user.role, now);
      return { kind: 'reuse' };
    }

    const issued = await this.sessions.issueRefreshToken(tx, {
      sessionId: session.id,
      familyId: token.familyId,
      sessionExpiresAt: session.expiresAt,
      now,
      ...(replacementId ? { id: replacementId } : {}),
    });
    if (decision === 'grace' && token.replacedById) {
      await tx.platformRefreshToken.updateMany({ where: { id: token.replacedById, usedAt: null }, data: { usedAt: now, replacedById: issued.id } });
    }
    await tx.platformSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    return { kind: 'ok', userId: session.userId, sessionId: session.id, role: session.user.role, mfa: session.mfaVerifiedAt !== null, refreshToken: issued.token };
  }

  private async load(tx: PlatformTx, tokenHash: Uint8Array<ArrayBuffer>, now: Date) {
    const token = await tx.platformRefreshToken.findUnique({
      where: { tokenHash },
      include: { session: { include: { user: { select: { status: true, role: true } } } } },
    });
    if (!token) return undefined;
    const replacement = token.replacedById
      ? await tx.platformRefreshToken.findUnique({ where: { id: token.replacedById }, select: { usedAt: true } })
      : null;
    const { session } = token;
    const decision: RefreshDecision =
      session.user.status === 'active'
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

  private async revokeFamily(tx: PlatformTx, familyId: string, sessionId: string, userId: string, role: string, now: Date): Promise<void> {
    await tx.platformRefreshToken.updateMany({ where: { familyId, usedAt: null }, data: { usedAt: now } });
    await tx.platformSession.update({ where: { id: sessionId }, data: { revokedAt: now, revokedReason: 'refresh_reuse_detected' } });
    await this.audit.record(tx, {
      action: 'platform.auth.refresh_reuse_detected',
      actor: { type: 'platform_user', userId, role },
      outcome: 'denied',
      resourceType: 'platform_session',
      resourceId: sessionId,
      changes: { familyId },
    });
  }
}
