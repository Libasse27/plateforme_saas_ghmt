import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PLATFORM_ROLES, type PlatformRole } from '@ghmt/shared';
import { z } from 'zod';
import { ACCESS_TOKEN_TTL_SECONDS } from '../../../common/auth/access-token.service';
import { DomainError } from '../../../common/errors/domain-error';
import { ENV, type Env } from '../../../infrastructure/config/env';

const ALGORITHM = 'HS256';

const claimsSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  realm: z.literal('platform'),
  role: z.enum(PLATFORM_ROLES),
  mfa: z.boolean(),
});

export interface PlatformTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: PlatformRole;
  readonly mfa: boolean;
}

/**
 * JWT d'accès du realm plateforme : claims `{ sub, sid, role, mfa }`, `realm: 'platform'`, audience dédiée.
 * Un jeton tenant (`realm: 'tenant'`, autre audience) est refusé ici, et inversement par `AccessTokenService`.
 */
@Injectable()
export class PlatformTokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get audience(): string {
    return `${this.env.JWT_AUDIENCE}-platform`;
  }

  sign(claims: PlatformTokenClaims): Promise<string> {
    return this.jwt.signAsync(
      { sid: claims.sessionId, realm: 'platform', role: claims.role, mfa: claims.mfa },
      {
        subject: claims.userId,
        algorithm: ALGORITHM,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        issuer: this.env.JWT_ISSUER,
        audience: this.audience,
        secret: this.env.JWT_PLATFORM_SECRET,
      },
    );
  }

  async verify(token: string): Promise<PlatformTokenClaims> {
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(token, {
        algorithms: [ALGORITHM],
        issuer: this.env.JWT_ISSUER,
        audience: this.audience,
        secret: this.env.JWT_PLATFORM_SECRET,
      });
    } catch {
      throw DomainError.unauthorized('Jeton invalide ou expiré.');
    }
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) throw DomainError.unauthorized('Jeton invalide ou expiré.');
    return { userId: parsed.data.sub, sessionId: parsed.data.sid, role: parsed.data.role, mfa: parsed.data.mfa };
  }

  get accessTokenTtlSeconds(): number {
    return ACCESS_TOKEN_TTL_SECONDS;
  }
}
