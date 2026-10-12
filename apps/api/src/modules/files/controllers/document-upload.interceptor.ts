import { BadRequestException, type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Observable } from 'rxjs';
import { MAX_UPLOAD_BYTES } from '@ghmt/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { DocumentErrors } from '../domain/document-errors';

/** Champ du fichier dans le multipart (docs/13 §5). */
export const UPLOAD_FILE_FIELD = 'file';

/**
 * Lecture multipart en mémoire, bornée (docs/13 D3) : un seul fichier de 10 Mo au plus, quelques champs courts.
 * Le nom de fichier est lu en UTF-8 (le BFF relaie le nom saisi par l'utilisateur).
 */
const UPLOAD_OPTIONS: MulterOptions = {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 6, headerPairs: 50 },
  defParamCharset: 'utf8',
};

/** Multer, avec les erreurs traduites dans le contrat : 413 `file_too_large`, 422 pour un multipart invalide. */
@Injectable()
export class DocumentUploadInterceptor implements NestInterceptor {
  private readonly multer: NestInterceptor = new (FileInterceptor(UPLOAD_FILE_FIELD, UPLOAD_OPTIONS))();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await this.multer.intercept(context, next);
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw DocumentErrors.fileTooLarge();
      if (error instanceof BadRequestException) {
        throw DomainError.validation([{ path: UPLOAD_FILE_FIELD, code: 'invalid_multipart', message: 'Formulaire de dépôt invalide.' }]);
      }
      throw error;
    }
  }
}
