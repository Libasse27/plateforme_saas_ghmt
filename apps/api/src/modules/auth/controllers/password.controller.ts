import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { changePasswordSchema, type ChangePasswordInput } from '@ghmt/shared';
import type { Principal } from '../../../common/context/request-context';
import { AuthenticatedOnly, CurrentPrincipal } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { PASSWORD_CHANGE_THROTTLE } from '../auth.constants';
import { PasswordChangeService } from '../services/password-change.service';

@Controller('auth/password')
export class PasswordController {
  constructor(private readonly passwordChange: PasswordChangeService) {}

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
