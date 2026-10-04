import { Module } from '@nestjs/common';
import { AuthController } from './controllers/auth.controller';
import { InvitationsPublicController } from './controllers/invitations.controller';
import { MfaController } from './controllers/mfa.controller';
import { PasswordController } from './controllers/password.controller';
import { SessionsController } from './controllers/sessions.controller';
import { InvitationAcceptService } from './services/invitation-accept.service';
import { LoginCompletionService } from './services/login-completion.service';
import { LoginService } from './services/login.service';
import { LogoutService } from './services/logout.service';
import { MfaEnrollmentService } from './services/mfa-enrollment.service';
import { MfaVerifyService } from './services/mfa-verify.service';
import { PasswordChangeService } from './services/password-change.service';
import { ProfileService } from './services/profile.service';
import { RefreshService } from './services/refresh.service';
import { SessionService } from './services/session.service';
import { SignupService } from './services/signup.service';
import { TotpService } from './services/totp.service';

/** Authentification : inscription, connexion, MFA TOTP, rotation des refresh tokens, sessions (docs/03 §4.1). */
@Module({
  controllers: [AuthController, MfaController, SessionsController, PasswordController, InvitationsPublicController],
  providers: [
    TotpService,
    SessionService,
    LoginCompletionService,
    LoginService,
    MfaVerifyService,
    MfaEnrollmentService,
    RefreshService,
    ProfileService,
    SignupService,
    LogoutService,
    PasswordChangeService,
    InvitationAcceptService,
  ],
})
export class AuthModule {}
