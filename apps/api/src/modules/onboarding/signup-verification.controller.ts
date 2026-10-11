import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  resendSignupVerificationSchema,
  verifySignupSchema,
  type ResendSignupVerificationInput,
  type SignupVerificationResult,
  type VerifySignupInput,
} from '@ghmt/shared';
import { Public } from '../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AccountThrottled } from '../../common/throttle/account-throttle';
import { RESEND_SIGNUP_THROTTLE, VERIFY_SIGNUP_THROTTLE } from './onboarding.constants';
import { SignupVerificationService } from './signup-verification.service';

/** Routes publiques : le jeton reçu par e-mail (transmis dans le corps, jamais dans l'URL) est la seule preuve d'accès. */
@Controller('auth/signup')
export class SignupVerificationController {
  constructor(private readonly verification: SignupVerificationService) {}

  @Public()
  @Throttle(VERIFY_SIGNUP_THROTTLE)
  @HttpCode(200)
  @Post('verify')
  verify(@Body(new ZodValidationPipe(verifySignupSchema)) body: VerifySignupInput): Promise<SignupVerificationResult> {
    return this.verification.verify(body.token);
  }

  @Public()
  @AccountThrottled('signup_resend')
  @Throttle(RESEND_SIGNUP_THROTTLE)
  @HttpCode(202)
  @Post('resend')
  resend(@Body(new ZodValidationPipe(resendSignupVerificationSchema)) body: ResendSignupVerificationInput): { accepted: true } {
    this.verification.requestResend(body);
    return { accepted: true };
  }
}
