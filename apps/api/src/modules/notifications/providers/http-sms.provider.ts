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
        headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
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
async function readMessageId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  } catch {
    return null;
  }
}
