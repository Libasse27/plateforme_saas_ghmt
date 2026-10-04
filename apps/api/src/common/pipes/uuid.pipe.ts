import { Injectable, type PipeTransform } from '@nestjs/common';
import { DomainError } from '../errors/domain-error';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un identifiant mal formé est traité comme introuvable (404), pas comme une erreur de validation. */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID_PATTERN.test(value)) throw DomainError.notFound();
    return value.toLowerCase();
  }
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
