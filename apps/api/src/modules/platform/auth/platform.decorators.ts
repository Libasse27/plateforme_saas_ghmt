import { Controller, SetMetadata, UseGuards, applyDecorators, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PlatformPermission } from '@ghmt/shared';
import { PlatformRealm } from '../../../common/decorators/realm.decorators';
import type { PlatformPrincipal, PlatformRequest } from './platform-auth.guard';
import { PlatformAuthGuard } from './platform-auth.guard';

import { PLATFORM_AUTH_ONLY_KEY, PLATFORM_PERMISSIONS_KEY, PLATFORM_PUBLIC_KEY } from './platform.keys';

/**
 * Contrôleur du realm plateforme. Le contournement des guards tenant (`PlatformRealm`) n'est jamais posé sans le guard
 * plateforme (`PlatformAuthGuard`) : les deux sont indissociables dans ce décorateur.
 */
export const PlatformController = (path: string): ClassDecorator =>
  applyDecorators(Controller(`platform/${path}`), PlatformRealm(), UseGuards(PlatformAuthGuard));

/** Route plateforme sans authentification (connexion, vérification MFA, refresh). */
export const PlatformPublic = (): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_PUBLIC_KEY, true);

/** Route authentifiée sans permission métier ni MFA exigée (enrôlement TOTP, profil). */
export const PlatformAuthenticatedOnly = (): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_AUTH_ONLY_KEY, true);

/** Permissions plateforme requises (toutes) ; la MFA vérifiée est exigée. */
export const RequirePlatformPermission = (...permissions: [PlatformPermission, ...PlatformPermission[]]): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_PERMISSIONS_KEY, permissions);

export const CurrentPlatformUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): PlatformPrincipal => {
  const principal = ctx.switchToHttp().getRequest<PlatformRequest>().platformPrincipal;
  if (!principal) throw new Error('CurrentPlatformUser utilisé sur une route publique');
  return principal;
});
