import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@ghmt/shared';
import type { Principal } from '../context/request-context';

export const IS_PUBLIC_KEY = 'ghmt:public';
export const IS_AUTHENTICATED_ONLY_KEY = 'ghmt:authenticated-only';
export const PERMISSIONS_KEY = 'ghmt:permissions';

/** Route accessible sans authentification (connexion, inscription, santé). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Route authentifiée sans permission métier (profil, déconnexion, enrôlement MFA).
 * Reste accessible même si la MFA est exigée mais pas encore enrôlée.
 */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator => SetMetadata(IS_AUTHENTICATED_ONLY_KEY, true);

/** Permissions requises (toutes). Refus par défaut : une route sans décorateur est interdite. */
export const RequirePermission = (...permissions: [PermissionKey, ...PermissionKey[]]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
  if (!req.principal) throw new Error('CurrentPrincipal utilisé sur une route publique');
  return req.principal;
});
