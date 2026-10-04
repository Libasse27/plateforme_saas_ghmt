import { SetMetadata } from '@nestjs/common';

export const PLATFORM_REALM_KEY = 'ghmt:platform-realm';
export const ALLOW_WHEN_SUSPENDED_KEY = 'ghmt:allow-when-suspended';

/**
 * Marque une route du realm plateforme : les guards globaux du realm tenant (JwtAuthGuard, PermissionGuard) la laissent
 * passer, et SEUL le guard plateforme l'authentifie. Ne jamais l'utiliser seul : voir `@PlatformController()`
 * (modules/platform) qui l'associe toujours au guard plateforme.
 */
export const PlatformRealm = (): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_REALM_KEY, true);

/**
 * Route tenant autorisée même quand le tenant est suspendu (lecture seule) : paiement de l'abonnement.
 * La permission requise reste vérifiée ; seul le blocage « suspendu » est levé.
 */
export const AllowWhenSuspended = (): MethodDecorator & ClassDecorator => SetMetadata(ALLOW_WHEN_SUSPENDED_KEY, true);
