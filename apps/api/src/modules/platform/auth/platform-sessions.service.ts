import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import type { PlatformRole, PlatformTokens } from '@ghmt/shared';
import { RequestContext } from '../../../common/context/request-context';
import type { PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { PLATFORM_REFRESH_TTL_MS, PLATFORM_SESSION_TTL_MS } from '../platform.constants';
import { issuePlatformToken } from './platform-opaque-token';
import { PlatformTokenService } from './platform-token.service';

export interface ClientMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface IssueRefreshParams {
  readonly sessionId: string;
  readonly familyId: string;
  readonly sessionExpiresAt: Date;
  readonly now: Date;
  /** Identifiant imposé : permet de chaîner `replacedById` avant l'insertion. */
  readonly id?: string;
}

/** Sessions et jetons du realm plateforme : même mécanique que le realm tenant (rotation, réutilisation, révocation). */
@Injectable()
export class PlatformSessionsService {
  constructor(
    private readonly tokens: PlatformTokenService,
    private readonly context: RequestContext,
  ) {}

  clientMeta(): ClientMeta {
    const state = this.context.state;
    return { ip: state?.ip && isIP(state.ip) ? state.ip : null, userAgent: state?.userAgent ?? null };
  }

  /** Ouvre une session et ses jetons ; `mfaVerified` faux ⇒ session limitée à l'enrôlement du second facteur. */
  async open(
    tx: PlatformTx,
    params: { userId: string; role: PlatformRole; mfaVerified: boolean; mfaEnrolled: boolean; now: Date },
  ): Promise<PlatformTokens & { sessionId: string }> {
    const meta = this.clientMeta();
    const session = await tx.platformSession.create({
      data: {
        userId: params.userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        mfaVerifiedAt: params.mfaVerified ? params.now : null,
        expiresAt: new Date(params.now.getTime() + PLATFORM_SESSION_TTL_MS),
        lastSeenAt: params.now,
      },
      select: { id: true, expiresAt: true },
    });
    const refresh = await this.issueRefreshToken(tx, { sessionId: session.id, familyId: randomUUID(), sessionExpiresAt: session.expiresAt, now: params.now });
    const accessToken = await this.tokens.sign({ userId: params.userId, sessionId: session.id, role: params.role, mfa: params.mfaVerified });
    return {
      sessionId: session.id,
      accessToken,
      refreshToken: refresh.token,
      expiresIn: this.tokens.accessTokenTtlSeconds,
      mfaEnrolled: params.mfaEnrolled,
      mfaRequired: true,
    };
  }

  /** Refresh de 2 h glissantes, borné par l'expiration absolue de la session. */
  async issueRefreshToken(tx: PlatformTx, params: IssueRefreshParams): Promise<{ id: string; token: string }> {
    const id = params.id ?? randomUUID();
    const issued = issuePlatformToken();
    await tx.platformRefreshToken.create({
      data: {
        id,
        sessionId: params.sessionId,
        familyId: params.familyId,
        tokenHash: issued.hash,
        issuedAt: params.now,
        expiresAt: new Date(Math.min(params.now.getTime() + PLATFORM_REFRESH_TTL_MS, params.sessionExpiresAt.getTime())),
      },
    });
    return { id, token: issued.token };
  }

  signAccessToken(userId: string, sessionId: string, role: PlatformRole, mfa: boolean): Promise<string> {
    return this.tokens.sign({ userId, sessionId, role, mfa });
  }

  get accessTokenTtlSeconds(): number {
    return this.tokens.accessTokenTtlSeconds;
  }
}
