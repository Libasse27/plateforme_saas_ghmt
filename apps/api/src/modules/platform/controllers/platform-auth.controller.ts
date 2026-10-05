import { Body, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  platformLoginSchema,
  platformLogoutSchema,
  platformMfaVerifySchema,
  platformRefreshSchema,
  platformPasswordChangeSchema,
  type PlatformLoginInput,
  type PlatformMfaVerifyInput,
  type PlatformPasswordChangeInput,
} from '@ghmt/shared';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { PlatformPrincipal } from '../auth/platform-auth.guard';
import { PlatformLoginService } from '../auth/platform-login.service';
import { PlatformPasswordService } from '../auth/platform-password.service';
import { PlatformRefreshService } from '../auth/platform-refresh.service';
import { CurrentPlatformUser, PlatformAuthenticatedOnly, PlatformController, PlatformPublic } from '../auth/platform.decorators';
import { PLATFORM_LOGIN_THROTTLE, PLATFORM_MFA_THROTTLE, PLATFORM_REFRESH_THROTTLE } from '../platform.constants';

/** Authentification du realm plateforme : connexion (MFA toujours exigée), refresh, déconnexion, profil. */
@PlatformController('auth')
export class PlatformAuthController {
  constructor(
    private readonly login: PlatformLoginService,
    private readonly passwords: PlatformPasswordService,
    private readonly refreshService: PlatformRefreshService,
  ) {}

  @PlatformPublic()
  @Throttle(PLATFORM_LOGIN_THROTTLE)
  @HttpCode(200)
  @Post('login')
  loginRoute(@Body(new ZodValidationPipe(platformLoginSchema)) body: PlatformLoginInput) {
    return this.login.login(body);
  }

  @PlatformPublic()
  @Throttle(PLATFORM_MFA_THROTTLE)
  @HttpCode(200)
  @Post('mfa/verify')
  verify(@Body(new ZodValidationPipe(platformMfaVerifySchema)) body: PlatformMfaVerifyInput) {
    return this.login.verifyMfa(body);
  }

  /**
   * Changement du mot de passe (mot de passe actuel exigé) : révoque les autres sessions. L'enrôlement du second facteur
   * n'existe plus en ligne : il est fait par `scripts/create-platform-admin.mts` (revue sécurité M2).
   */
  @PlatformAuthenticatedOnly()
  @Throttle(PLATFORM_LOGIN_THROTTLE)
  @HttpCode(200)
  @Post('password/change')
  changePassword(@CurrentPlatformUser() principal: PlatformPrincipal, @Body(new ZodValidationPipe(platformPasswordChangeSchema)) body: PlatformPasswordChangeInput) {
    return this.passwords.change(principal, body);
  }

  @PlatformPublic()
  @Throttle(PLATFORM_REFRESH_THROTTLE)
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe(platformRefreshSchema)) body: { refreshToken: string }) {
    return this.refreshService.refresh(body.refreshToken);
  }

  /** Publique : le jeton de rafraîchissement du corps suffit ; sinon la session du jeton d'accès fourni est révoquée. */
  @PlatformPublic()
  @Throttle(PLATFORM_REFRESH_THROTTLE)
  @HttpCode(204)
  @Post('logout')
  async logout(
    @Body(new ZodValidationPipe(platformLogoutSchema.default({}))) body: { refreshToken?: string | undefined },
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const accessToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined;
    await this.refreshService.logout({ refreshToken: body.refreshToken, accessToken });
  }

  @PlatformAuthenticatedOnly()
  @Get('me')
  me(@CurrentPlatformUser() principal: PlatformPrincipal) {
    return this.refreshService.me(principal);
  }
}
