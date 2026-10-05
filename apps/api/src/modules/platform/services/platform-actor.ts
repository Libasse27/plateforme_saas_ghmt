import type { PlatformActor } from '../../../common/audit/platform-audit.service';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';

/** Acteur d'audit correspondant à l'utilisateur plateforme authentifié. */
export function actorOf(principal: PlatformPrincipal): PlatformActor {
  return { type: 'platform_user', userId: principal.userId, role: principal.role };
}
