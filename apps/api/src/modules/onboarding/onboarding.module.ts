import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PendingSignupExpiryJob } from './pending-signup-expiry.job';
import { SignupVerificationController } from './signup-verification.controller';
import { SignupVerificationService } from './signup-verification.service';

/** Inscription vérifiée et expiration des inscriptions non confirmées (équipe OPS, docs/11 §6). */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [SignupVerificationController],
  providers: [SignupVerificationService, PendingSignupExpiryJob],
  exports: [PendingSignupExpiryJob],
})
export class OnboardingModule {}
