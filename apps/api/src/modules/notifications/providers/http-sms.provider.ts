import { classifyHttpStatus, classifyNetworkError } from '../domain/error-classification';
import { SmsProviderError, type SmsProvider, type SmsSendRequest, type SmsSendResult } from './sms-provider';

export interface HttpSmsConfig {
  readonly url: string;
  readonly token: string;
  readonly senderId: string;
  readonly timeoutMs: number;
}

/** Adaptateur HTTP générique (docs/10 §5.7) : `POST url`, jeton Bearer, JSON `{ to, from, text, clientRef }`. */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http' as const;

  constructor(
    private readonly config: HttpSmsConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json', 'idempotency-key': request.clientRef },
        redirect: 'error',
        body: JSON.stringify({ to: request.to, from: this.config.senderId, text: request.text, clientRef: request.clientRef }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error: unknown) {
      const classified = classifyNetworkError(error);
      throw new SmsProviderError(classified.errorClass, classified.errorCode);
    }
    const failure = classifyHttpStatus(response.status);
    if (failure) throw new SmsProviderError(failure.errorClass, failure.errorCode);
    return { providerMessageId: await readMessageId(response) };
  }
}

/** `{ id }` de la réponse ; un corps absent ou illisible n'invalide pas un envoi accepté (2xx). */
const MAX_RESPONSE_BYTES = 4_096;

/** Lit au plus 4 Ko de la réponse ; au-delà, elle est ignorée (un fournisseur ne doit pas pouvoir saturer la mémoire). */
async function readBounded(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readMessageId(response: Response): Promise<string | null> {
  try {
    const text = await readBounded(response);
    if (text === null) return null;
    const body: unknown = JSON.parse(text);
    const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  } catch {
    return null;
  }
}
