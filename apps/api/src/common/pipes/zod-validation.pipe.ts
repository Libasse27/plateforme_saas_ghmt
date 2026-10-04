import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { DomainError } from '../errors/domain-error';

/**
 * Valide et transforme une entrée avec un schéma Zod partagé (packages/shared).
 * Les champs inconnus du corps sont retirés ; échec ⇒ 422 validation_failed.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw DomainError.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
        message: issue.message,
      })),
    );
  }
}
