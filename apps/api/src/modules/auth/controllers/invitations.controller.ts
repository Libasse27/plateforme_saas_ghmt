import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { acceptInvitationSchema, type AcceptInvitationInput, type InvitationPreview } from '@ghmt/shared';
import { Public } from '../../../common/decorators/auth.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { INVITATION_THROTTLE } from '../auth.constants';
import { InvitationAcceptService } from '../services/invitation-accept.service';

/** Routes publiques : le jeton d'invitation `<tenantId>.<secret>` est la seule preuve d'accès. */
@Controller('auth/invitations')
export class InvitationsPublicController {
  constructor(private readonly invitations: InvitationAcceptService) {}

  @Public()
  @Throttle(INVITATION_THROTTLE)
  @Get(':token')
  preview(@Param('token') token: string): Promise<InvitationPreview> {
    return this.invitations.preview(token);
  }

  @Public()
  @Throttle(INVITATION_THROTTLE)
  @HttpCode(204)
  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: AcceptInvitationInput,
  ): Promise<void> {
    await this.invitations.accept(token, body.password);
  }
}
