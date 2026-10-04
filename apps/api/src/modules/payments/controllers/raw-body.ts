import type { Request } from 'express';
import { DomainError } from '../../../common/errors/domain-error';
import { WEBHOOK_BODY_LIMIT_BYTES } from '../payments.constants';

/**
 * Corps brut d'une requête de webhook : conservé par l'analyseur JSON (`rawBody`, voir bootstrap) ou, pour les autres
 * types de contenu (ex. application/x-www-form-urlencoded de CinetPay), lu directement dans le flux, borné à 1 Mo.
 */
export async function readRawBody(req: Request & { rawBody?: Buffer }): Promise<Buffer> {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (req.readableEnded || !req.readable) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > WEBHOOK_BODY_LIMIT_BYTES) throw new DomainError('payload_too_large', 413, 'Payload Too Large', 'Corps de requête trop volumineux.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
