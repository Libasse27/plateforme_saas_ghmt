import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { ENV, type Env } from '../../infrastructure/config/env';
import type { Principal } from '../context/request-context';
import { DomainError } from '../errors/domain-error';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ALGORITHM = 'HS256';

const claimsSchema = z.object({
  sub: z.uuid(),
  tid: z.uuid(),
  sid: z.uuid(),
  realm: z.literal('tenant'),
  mfa: z.boolean(),
});

/**
 * JWT d'accès court (15 min, docs/04 §1.2). Les permissions ne sont PAS dans le jeton.
 * MVP : HS256 à secret unique, algorithme figé. Cible : EdDSA avec `kid` et rotation.
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  sign(principal: Principal): Promise<string> {
    return this.jwt.signAsync(
      { tid: principal.tenantId, sid: principal.sessionId, realm: 'tenant', mfa: principal.mfa },
      {
        subject: principal.userId,
        algorithm: ALGORITHM,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        secret: this.env.JWT_ACCESS_SECRET,
      },
    );
  }

  async verify(token: string): Promise<Principal> {
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(token, {
        algorithms: [ALGORITHM],
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        secret: this.env.JWT_ACCESS_SECRET,
      });
    } catch {
      throw DomainError.unauthorized('Jeton invalide ou expiré.');
    }
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) throw DomainError.unauthorized('Jeton invalide ou expiré.');
    return { userId: claims.data.sub, tenantId: claims.data.tid, sessionId: claims.data.sid, mfa: claims.data.mfa };
  }
}
