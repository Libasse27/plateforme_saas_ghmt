import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { deleteDocumentSchema, filePurposeSchema, type DeleteDocumentInput, type PatientDocumentView } from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { PatientDocumentsService, type UploadedDocument } from '../services/patient-documents.service';
import { DocumentUploadInterceptor } from './document-upload.interceptor';

/** Champs texte du multipart de dépôt (le fichier est lu par l'intercepteur). */
const uploadFieldsSchema = z.object({ purpose: filePurposeSchema });

/**
 * Documents administratifs du patient (docs/13 §5) : le navigateur n'y accède que par le BFF (D3), jamais par une URL
 * de stockage.
 */
@Controller('patients/:patientId/documents')
export class PatientDocumentsController {
  constructor(private readonly documents: PatientDocumentsService) {}

  @Post()
  @RequirePermission('patients:identity_doc:create')
  @UseInterceptors(DocumentUploadInterceptor)
  upload(
    @Param('patientId', UuidPipe) patientId: string,
    @Body(new ZodValidationPipe(uploadFieldsSchema)) fields: z.infer<typeof uploadFieldsSchema>,
    @UploadedFile() file: UploadedDocument | undefined,
  ): Promise<PatientDocumentView> {
    return this.documents.upload(patientId, fields.purpose, file);
  }

  @Get()
  @RequirePermission('patients:identity_doc:read')
  list(@Param('patientId', UuidPipe) patientId: string): Promise<{ items: PatientDocumentView[] }> {
    return this.documents.list(patientId);
  }

  /** Contenu déjà déchiffré et vérifié (aucun octet n'est envoyé si l'intégrité échoue) : `Content-Type` fixé par le serveur, `attachment`, `nosniff`, jamais mis en cache. */
  @Get(':id/content')
  @RequirePermission('patients:identity_doc:read')
  async content(@Param('patientId', UuidPipe) patientId: string, @Param('id', UuidPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.documents.openContent(patientId, id);
    res.status(200);
    res.setHeader('Content-Type', content.mimeType);
    res.setHeader('Content-Length', String(content.data.length));
    res.setHeader('Content-Disposition', content.contentDisposition);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.end(content.data);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('patients:identity_doc:delete')
  remove(
    @Param('patientId', UuidPipe) patientId: string,
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(deleteDocumentSchema)) body: DeleteDocumentInput,
  ): Promise<void> {
    return this.documents.remove(patientId, id, body);
  }
}
