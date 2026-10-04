import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  mfaVerifySchema,
  totpActivateSchema,
  type MfaVerifyInput,
  type SessionTokens,
  type TotpActivateResponse,
  type TotpSetupResponse,
} from '@ghmt/shared';
import type { Principal } from '../../../common/context/request-context';
import { AuthenticatedOnly, CurrentPrincipal, Public } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { AccountThrottled } from '../../../common/throttle/account-throttle';
import { MFA_ACTIVATE_THROTTLE, MFA_VERIFY_THROTTLE } from '../auth.constants';
import { MfaEnrollmentService } from '../services/mfa-enrollment.service';
import { MfaVerifyService } from '../services/mfa-verify.service';

@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly verifyService: MfaVerifyService,
    private readonly enrollment: MfaEnrollmentService,
  ) {}

  @Public()
  @AccountThrottled('mfa')
  @Throttle(MFA_VERIFY_THROTTLE)
  @HttpCode(200)
  @Post('verify')
  verify(@Body(new ZodValidationPipe(mfaVerifySchema)) body: MfaVerifyInput): Promise<SessionTokens> {
    return this.verifyService.verify(body);
  }

  @AuthenticatedOnly()
  @HttpCode(200)
  @Post('totp/setup')
  setup(@CurrentPrincipal() principal: Principal): Promise<TotpSetupResponse> {
    return this.enrollment.setup(principal);
  }

  @AuthenticatedOnly()
  @Throttle(MFA_ACTIVATE_THROTTLE)
  @HttpCode(200)
  @Post('totp/activate')
  activate(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(totpActivateSchema)) body: { code: string },
  ): Promise<TotpActivateResponse> {
    return this.enrollment.activate(principal, body.code);
  }
}
