import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  passwordResetTokenSchema,
  resetPasswordSchema,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type PasswordResetPreview,
  type PasswordResetTokenInput,
  type ResetPasswordInput,
} from '@ghmt/shared';
import type { Principal } from '../../../common/context/request-context';
import { AuthenticatedOnly, CurrentPrincipal, Public } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { AccountThrottled } from '../../../common/throttle/account-throttle';
import { PASSWORD_CHANGE_THROTTLE, PASSWORD_FORGOT_THROTTLE, PASSWORD_RESET_PREVIEW_THROTTLE, PASSWORD_RESET_THROTTLE } from '../auth.constants';
import { PasswordResetService } from '../services/password-reset.service';
import { PasswordChangeService } from '../services/password-change.service';

@Controller('auth/password')
export class PasswordController {
  constructor(
    private readonly passwordChange: PasswordChangeService,
    private readonly reset: PasswordResetService,
  ) {}

  /** Répond toujours 202 `{ accepted: true }` : le traitement a lieu après la réponse (aucun oracle de compte). */
  @Public()
  @AccountThrottled('password_forgot')
  @Throttle(PASSWORD_FORGOT_THROTTLE)
  @HttpCode(202)
  @Post('forgot')
  forgot(@Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordInput): { accepted: true } {
    return this.reset.requestReset(body);
  }

  @Public()
  @Throttle(PASSWORD_RESET_PREVIEW_THROTTLE)
  @HttpCode(200)
  @Post('reset/preview')
  preview(@Body(new ZodValidationPipe(passwordResetTokenSchema)) body: PasswordResetTokenInput): Promise<PasswordResetPreview> {
    return this.reset.preview(body.token);
  }

  @Public()
  @AccountThrottled('password_reset')
  @Throttle(PASSWORD_RESET_THROTTLE)
  @HttpCode(204)
  @Post('reset')
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput): Promise<void> {
    await this.reset.reset(body);
  }

  /** Accessible même quand `mustChangePassword` bloque les routes métier (c'est la sortie de ce blocage). */
  @AuthenticatedOnly()
  @Throttle(PASSWORD_CHANGE_THROTTLE)
  @HttpCode(204)
  @Post('change')
  async change(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
  ): Promise<void> {
    await this.passwordChange.change(principal, body);
  }
}
