import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { recordContactConsentSchema, type ContactConsentsView, type RecordContactConsentInput } from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { AllowWhenSuspended } from '../../../common/decorators/realm.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { ConsentsService } from '../services/consents.service';

@Controller('patients/:patientId/contact-consents')
export class ConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  @Get()
  @RequirePermission('patients:consent:read')
  get(@Param('patientId', UuidPipe) patientId: string): Promise<ContactConsentsView> {
    return this.consents.get(patientId);
  }

  /** Autorisé en lecture seule d'abonnement : recueillir ou retirer un consentement ne doit jamais être bloqué par un impayé. */
  @Post()
  @AllowWhenSuspended()
  @RequirePermission('patients:consent:create')
  record(@Param('patientId', UuidPipe) patientId: string, @Body(new ZodValidationPipe(recordContactConsentSchema)) body: RecordContactConsentInput): Promise<ContactConsentsView> {
    return this.consents.record(patientId, body);
  }
}
