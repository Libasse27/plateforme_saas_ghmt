import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { deriveRecipientKey, recipientHash } from '../domain/masking';

/** HMAC des destinataires (`recipient_hash`, `phone_hmac`) avec une clé dérivée de BLIND_INDEX_KEY (docs/10 D6, §8). */
@Injectable()
export class RecipientHasher {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Env) {
    this.key = deriveRecipientKey(env.BLIND_INDEX_KEY);
  }

  hash(address: string): Buffer {
    return recipientHash(this.key, address);
  }
}
