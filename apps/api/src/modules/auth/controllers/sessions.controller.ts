import { Controller, Delete, Get, HttpCode, Param } from '@nestjs/common';
import type { SessionSummary } from '@ghmt/shared';
import type { Principal } from '../../../common/context/request-context';
import { AuthenticatedOnly, CurrentPrincipal } from '../../../common/decorators/auth.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { SessionService } from '../services/session.service';

@Controller('auth/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionService) {}

  @AuthenticatedOnly()
  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<SessionSummary[]> {
    return this.sessions.listOwn(principal);
  }

  @AuthenticatedOnly()
  @HttpCode(204)
  @Delete(':id')
  async revoke(@CurrentPrincipal() principal: Principal, @Param('id', UuidPipe) id: string): Promise<void> {
    await this.sessions.revokeOwn(principal, id, 'user_revoked');
  }
}
