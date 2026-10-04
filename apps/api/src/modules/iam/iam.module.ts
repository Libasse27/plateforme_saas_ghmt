import { Module } from '@nestjs/common';
import { RolesController } from './controllers/roles.controller';
import { UsersController } from './controllers/users.controller';
import { AssignmentsService } from './services/assignments.service';
import { InvitationsService } from './services/invitations.service';
import { RolesService } from './services/roles.service';
import { UsersService } from './services/users.service';

/** Module iam : utilisateurs, rôles, affectations, sessions (docs/04 §2-§3). */
@Module({
  controllers: [UsersController, RolesController],
  providers: [UsersService, RolesService, AssignmentsService, InvitationsService],
})
export class IamModule {}
