import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import type { SessionSummary } from '@ghmt/shared';
import { AccessTokenService, ACCESS_TOKEN_TTL_SECONDS } from '../../../common/auth/access-token.service';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext, type Principal } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { REFRESH_TOKEN_TTL_MS, SESSION_TTL_MS } from '../auth.constants';
import { issueOpaqueToken } from '../../../common/auth/opaque-token';

export interface ClientMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface OpenedSession {
  readonly sessionId: string;
  readonly refreshToken: string;
}

export interface IssueRefreshParams {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly sessionExpiresAt: Date;
  readonly now: Date;
  /** Identifiant imposé (permet de chaîner `replacedById` avant l'insertion). */
  readonly id?: string;
}

/** Cycle de vie des sessions : ouverture, émission des jetons, liste, révocation. */
@Injectable()
export class SessionService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tokens: AccessTokenService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  clientMeta(): ClientMeta {
    const state = this.context.state;
    // L'IP alimente une colonne inet : toute valeur non valide est écartée plutôt que de faire échouer l'appel.
    const ip = state?.ip && isIP(state.ip) ? state.ip : null;
    return { ip, userAgent: state?.userAgent ?? null };
  }

  async open(tx: TenantTx, params: { tenantId: string; userId: string; mfaVerified: boolean; now: Date }): Promise<OpenedSession> {
    const { tenantId, userId, mfaVerified, now } = params;
    const meta = this.clientMeta();
    const session = await tx.session.create({
      data: {
        tenantId,
        userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        mfaVerifiedAt: mfaVerified ? now : null,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        lastSeenAt: now,
      },
      select: { id: true, expiresAt: true },
    });
    const refresh = await this.issueRefreshToken(tx, {
      tenantId,
      sessionId: session.id,
      familyId: randomUUID(),
      sessionExpiresAt: session.expiresAt,
      now,
    });
    return { sessionId: session.id, refreshToken: refresh.token };
  }

  /** Refresh de 7 jours glissants, borné par l'expiration absolue de la session (30 jours). */
  async issueRefreshToken(tx: TenantTx, params: IssueRefreshParams): Promise<{ id: string; token: string }> {
    const { tenantId, sessionId, familyId, sessionExpiresAt, now } = params;
    const id = params.id ?? randomUUID();
    const issued = issueOpaqueToken(tenantId);
    const slidingExpiry = now.getTime() + REFRESH_TOKEN_TTL_MS;
    await tx.refreshToken.create({
      data: {
        id,
        tenantId,
        sessionId,
        familyId,
        tokenHash: issued.hash,
        issuedAt: now,
        expiresAt: new Date(Math.min(slidingExpiry, sessionExpiresAt.getTime())),
      },
    });
    return { id, token: issued.token };
  }

  signAccessToken(principal: Principal): Promise<string> {
    return this.tokens.sign(principal);
  }

  get accessTokenTtlSeconds(): number {
    return ACCESS_TOKEN_TTL_SECONDS;
  }

  /** Sessions actives de l'utilisateur courant uniquement. */
  async listOwn(principal: Principal): Promise<SessionSummary[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx.session.findMany({
        where: { userId: principal.userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      current: row.id === principal.sessionId,
      userAgent: row.userAgent,
      ip: row.ip,
      mfaVerified: row.mfaVerifiedAt !== null,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));
  }

  /** Révoque une session de l'utilisateur courant ; toute autre (autre utilisateur ou autre tenant) ⇒ 404. */
  async revokeOwn(principal: Principal, sessionId: string, reason: 'user_revoked' | 'logout'): Promise<void> {
    await this.tenantDb.run(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id: sessionId, userId: principal.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      if (count === 0) throw DomainError.notFound('Session');
      await this.audit.record(tx, principal.tenantId, {
        action: reason === 'logout' ? 'auth.logout' : 'auth.session.revoked',
        resourceType: 'session',
        resourceId: sessionId,
      });
    });
  }
}
