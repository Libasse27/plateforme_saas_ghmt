import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';

/**
 * Validation d'un PATCH : Zod 4 applique les `.default()` même sous `.partial()`
 * (ex. `sex` retomberait à 'unknown'). On ne conserve donc que les clés réellement envoyées.
 */
@Injectable()
export class PartialBodyPipe<T extends object> implements PipeTransform<unknown, Partial<T>> {
  private readonly validator: ZodValidationPipe<T>;

  constructor(schema: ZodType<T>) {
    this.validator = new ZodValidationPipe(schema);
  }

  transform(value: unknown): Partial<T> {
    const parsed = this.validator.transform(value);
    const sent = new Set(Object.keys(value as object));
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => sent.has(key))) as Partial<T>;
  }
}
