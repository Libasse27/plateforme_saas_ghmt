import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  createPatientQuerySchema,
  createPatientSchema,
  deletePatientSchema,
  searchPatientsSchema,
  updatePatientSchema,
  type CreatePatientInput,
  type CreatePatientQuery,
  type DeletePatientInput,
  type SearchPatientsInput,
  type UpdatePatientInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { etagOf, requireIfMatch } from '../../../common/http/if-match';
import type { Page } from '../../../common/pagination/page';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import type { PatientDetail, PatientSummary } from '../mappers/patient.mapper';
import { PatientsService } from '../services/patients.service';
import { PartialBodyPipe } from './partial-body.pipe';

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Post()
  @RequirePermission('patients:patient:create')
  create(
    @Body(new ZodValidationPipe(createPatientSchema)) body: CreatePatientInput,
    @Query(new ZodValidationPipe(createPatientQuerySchema)) query: CreatePatientQuery,
  ): Promise<PatientDetail> {
    return this.patients.create(body, query.force);
  }

  /** Recherche par POST : aucun terme de recherche (donnée de santé) dans une URL, donc ni logs d'accès ni historique. */
  @Post('search')
  @HttpCode(200)
  @RequirePermission('patients:patient:read')
  search(@Body(new ZodValidationPipe(searchPatientsSchema)) body: SearchPatientsInput): Promise<Page<PatientSummary>> {
    return this.patients.search(body);
  }

  @Get(':id')
  @RequirePermission('patients:patient:read')
  async get(@Param('id', UuidPipe) id: string, @Res({ passthrough: true }) res: Response): Promise<PatientDetail> {
    const patient = await this.patients.get(id);
    res.setHeader('ETag', etagOf(patient.rowVersion));
    return patient;
  }

  @Patch(':id')
  @RequirePermission('patients:patient:update')
  async update(
    @Param('id', UuidPipe) id: string,
    @Body(new PartialBodyPipe(updatePatientSchema)) body: UpdatePatientInput,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PatientDetail> {
    const patient = await this.patients.update(id, body, requireIfMatch(ifMatch));
    res.setHeader('ETag', etagOf(patient.rowVersion));
    return patient;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('patients:patient:delete')
  remove(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(deletePatientSchema)) body: DeletePatientInput,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    return this.patients.remove(id, body, requireIfMatch(ifMatch));
  }
}
