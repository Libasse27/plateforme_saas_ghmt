import { Injectable } from '@nestjs/common';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { KNOWN_LOGIN_IP_WINDOW_MS } from '../auth.constants';
import type { LoginContext } from './login-delay.service';
import { SessionService } from './session.service';

/**
 * Contexte d'une tentative pour le délai progressif (docs/11 décision 25) : réseau de confiance de l'établissement et IP
 * déjà à l'origine d'une session de ce compte (90 derniers jours ; IPv6 comparée par /64). Lecture dans sa propre
 * transaction courte, appelée seulement quand le compteur du compte impose un délai.
 */
@Injectable()
export class LoginContextService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly authz: AuthorizationService,
    private readonly sessions: SessionService,
  ) {}

  async evaluate(tenantId: string, email: string, now: Date): Promise<LoginContext> {
    const { ip } = this.sessions.clientMeta();
    if (!ip) return { ip: null, trustedNetwork: false, knownIp: false };
    const since = new Date(now.getTime() - KNOWN_LOGIN_IP_WINDOW_MS);
    return this.tenantDb.runAs(tenantId, async (tx) => {
      const policy = await this.authz.loadNetworkPolicy(tx, ip);
      const [row] = await tx.$queryRaw<{ known: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM tenant.sessions s
          JOIN tenant.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
          WHERE s.tenant_id = ${tenantId}::uuid AND u.email = ${email} AND s.created_at >= ${since}
            AND s.ip IS NOT NULL AND family(s.ip) = family(${ip}::inet)
            AND network(set_masklen(s.ip, CASE family(s.ip) WHEN 4 THEN 32 ELSE 64 END))
              = network(set_masklen(${ip}::inet, CASE family(${ip}::inet) WHEN 4 THEN 32 ELSE 64 END))
        ) AS known`;
      return { ip, trustedNetwork: policy.networkTrusted, knownIp: row?.known === true };
    });
  }
}
