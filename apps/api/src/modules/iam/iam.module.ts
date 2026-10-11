import { Module } from '@nestjs/common';
import { LoginDelayService } from '../auth/services/login-delay.service';
import { MfaCodeChecker } from '../auth/services/mfa-code-checker.service';
import { TotpService } from '../auth/services/totp.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RolesController } from './controllers/roles.controller';
import { SecurityController } from './controllers/security.controller';
import { UsersController } from './controllers/users.controller';
import { AssignmentsService } from './services/assignments.service';
import { HierarchyService } from './services/hierarchy.service';
import { InvitationsService } from './services/invitations.service';
import { RolesService } from './services/roles.service';
import { SecurityPolicyReader } from './services/security-policy.reader';
import { SecurityService } from './services/security.service';
import { StepUpService } from './services/step-up.service';
import { UserSecurityService } from './services/user-security.service';
import { UserViewsService } from './services/user-views.service';
import { UsersService } from './services/users.service';

/** Module iam : utilisateurs, rôles, affectations, sessions, politique de sécurité (docs/04 §2-§3, docs/11 §5.4). */
@Module({
  imports: [NotificationsModule],
  controllers: [UsersController, RolesController, SecurityController],
  providers: [
    UsersService,
    UserViewsService,
    UserSecurityService,
    RolesService,
    AssignmentsService,
    InvitationsService,
    HierarchyService,
    SecurityService,
    SecurityPolicyReader,
    StepUpService,
    LoginDelayService,
    // Vérification du code TOTP des opérations de pouvoir (décision 23), partagée avec `mfa/verify`.
    MfaCodeChecker,
    TotpService,
  ],
})
export class IamModule {}
