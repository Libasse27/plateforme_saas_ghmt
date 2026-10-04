import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  loginSchema,
  logoutSchema,
  refreshRequestSchema,
  signupTenantSchema,
  type AuthTokens,
  type LoginInput,
  type LoginResponse,
  type LogoutInput,
  type MeResponse,
  type RefreshRequestInput,
  type SignupResponse,
  type SignupTenantInput,
} from '@ghmt/shared';
import type { Principal } from '../../../common/context/request-context';
import { AuthenticatedOnly, CurrentPrincipal, Public } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { AccountThrottled } from '../../../common/throttle/account-throttle';
import { LOGIN_THROTTLE, LOGOUT_THROTTLE, SIGNUP_THROTTLE } from '../auth.constants';
import { LoginService } from '../services/login.service';
import { ProfileService } from '../services/profile.service';
import { RefreshService } from '../services/refresh.service';
import { LogoutService } from '../services/logout.service';
import { SignupService } from '../services/signup.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly signupService: SignupService,
    private readonly loginService: LoginService,
    private readonly refreshService: RefreshService,
    private readonly logoutService: LogoutService,
    private readonly profile: ProfileService,
  ) {}

  @Public()
  @Throttle(SIGNUP_THROTTLE)
  @Post('signup')
  signup(@Body(new ZodValidationPipe(signupTenantSchema)) body: SignupTenantInput): Promise<SignupResponse> {
    return this.signupService.signup(body);
  }

  @Public()
  @AccountThrottled('login')
  @Throttle(LOGIN_THROTTLE)
  @HttpCode(200)
  @Post('login')
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput): Promise<LoginResponse> {
    return this.loginService.login(body);
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe(refreshRequestSchema)) body: RefreshRequestInput): Promise<AuthTokens> {
    return this.refreshService.refresh(body.refreshToken);
  }

  /**
   * Publique : le jeton de rafraîchissement du corps suffit (même jeton d'accès expiré).
   * Sans corps, la session du jeton d'accès fourni en `Authorization` est révoquée.
   */
  @Public()
  @Throttle(LOGOUT_THROTTLE)
  @HttpCode(204)
  @Post('logout')
  async logout(
    @Body(new ZodValidationPipe(logoutSchema.default({}))) body: LogoutInput,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const accessToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined;
    await this.logoutService.logout({ refreshToken: body.refreshToken, accessToken });
  }

  @AuthenticatedOnly()
  @Get('me')
  me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    return this.profile.me(principal);
  }
}
