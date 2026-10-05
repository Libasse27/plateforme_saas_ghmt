import { describe, expect, it, vi } from 'vitest';
import type { Mailer } from '../../../common/mail/mailer';
import type { Env } from '../../../infrastructure/config/env';
import { HttpSmsProvider } from './http-sms.provider';
import { SandboxSmsProvider } from './sandbox-sms.provider';
import { createSmsProvider } from './sms-provider.factory';
import { SmsProviderError, UnavailableSmsProvider, type SmsSendRequest } from './sms-provider';

const REQUEST: SmsSendRequest = { to: '+221771234545', text: 'Rappel : rendez-vous demain', clientRef: 'tenant.notification', maskedTo: '+22177*****45' };
const CONFIG = { url: 'https://sms.example.com/send', token: 'jeton-secret-0123456789', senderId: 'GHMT', timeoutMs: 5_000 };

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function failureOf(promise: Promise<unknown>): Promise<SmsProviderError> {
  try {
    await promise;
  } catch (error) {
    return error as SmsProviderError;
  }
  throw new Error('une erreur était attendue');
}

describe('HttpSmsProvider', () => {
  it('envoie un POST JSON authentifié par jeton Bearer avec le contrat du §5.7', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { id: 'msg-42' }));
    const provider = new HttpSmsProvider(CONFIG, fetchMock);

    const result = await provider.send(REQUEST);

    expect(result).toEqual({ providerMessageId: 'msg-42' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONFIG.url);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${CONFIG.token}`);
    expect(JSON.parse(init.body as string)).toEqual({ to: REQUEST.to, from: 'GHMT', text: REQUEST.text, clientRef: REQUEST.clientRef });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepte une réponse 2xx sans identifiant', async () => {
    const provider = new HttpSmsProvider(CONFIG, vi.fn().mockResolvedValue(new Response(null, { status: 202 })));

    expect(await provider.send(REQUEST)).toEqual({ providerMessageId: null });
  });

  it.each([
    [400, 'permanent_recipient'],
    [404, 'permanent_recipient'],
    [422, 'permanent_recipient'],
    [401, 'permanent_config'],
    [402, 'permanent_config'],
    [403, 'permanent_config'],
    [408, 'transient'],
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
  ])('classe la réponse %i en %s', async (status, errorClass) => {
    const provider = new HttpSmsProvider(CONFIG, vi.fn().mockResolvedValue(response(status, { error: 'détail du fournisseur' })));

    const error = await failureOf(provider.send(REQUEST));

    expect(error).toBeInstanceOf(SmsProviderError);
    expect(error.errorClass).toBe(errorClass);
    expect(error.errorCode).toBe(`http_${status}`);
  });

  it('classe un délai dépassé et une panne réseau comme transitoires', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });

    const slow = await failureOf(new HttpSmsProvider(CONFIG, vi.fn().mockRejectedValue(timeout)).send(REQUEST));
    const down = await failureOf(new HttpSmsProvider(CONFIG, vi.fn().mockRejectedValue(new TypeError('fetch failed'))).send(REQUEST));

    expect([slow.errorClass, slow.errorCode]).toEqual(['transient', 'timeout']);
    expect([down.errorClass, down.errorCode]).toEqual(['transient', 'network_error']);
  });

  it('n’expose ni le jeton, ni le numéro, ni le texte dans ses erreurs', async () => {
    const provider = new HttpSmsProvider(CONFIG, vi.fn().mockRejectedValue(new Error(`échec vers ${REQUEST.to} avec ${CONFIG.token}`)));

    const error = await failureOf(provider.send(REQUEST));

    expect(error.message).not.toContain(CONFIG.token);
    expect(error.message).not.toContain('221771234545');
    expect(JSON.stringify(error)).not.toContain(REQUEST.text);
  });
});

describe('SandboxSmsProvider', () => {
  it('conserve les SMS « envoyés » et renvoie un identifiant fournisseur', async () => {
    const provider = new SandboxSmsProvider();

    const result = await provider.send(REQUEST);

    expect(result.providerMessageId).toMatch(/^sbx-/);
    expect(provider.messages).toEqual([expect.objectContaining({ to: REQUEST.to, text: REQUEST.text, clientRef: REQUEST.clientRef })]);
  });

  it('simule des pannes programmées, une par envoi, puis reprend', async () => {
    const provider = new SandboxSmsProvider();
    provider.failNext(new SmsProviderError('transient', 'http_503'));

    const error = await failureOf(provider.send(REQUEST));
    const ok = await provider.send(REQUEST);

    expect(error.errorCode).toBe('http_503');
    expect(ok.providerMessageId).toMatch(/^sbx-/);
    expect(provider.messages).toHaveLength(1);
  });

  it('n’envoie aucune copie par e-mail sans boîte de copie (tests)', async () => {
    const mailer: Mailer = { send: vi.fn() };
    const provider = new SandboxSmsProvider();

    await provider.send(REQUEST);

    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('copie le SMS vers la boîte configurée avec un sujet masqué (développement)', async () => {
    const mailer: Mailer = { send: vi.fn().mockResolvedValue(undefined) };
    const provider = new SandboxSmsProvider({ mailer, mailbox: 'sms-sandbox@ghmt.local' });

    await provider.send(REQUEST);

    expect(mailer.send).toHaveBeenCalledWith({ to: 'sms-sandbox@ghmt.local', subject: 'SMS → +22177*****45', text: REQUEST.text });
  });

  it('un échec de la copie e-mail n’échoue pas l’envoi simulé', async () => {
    const mailer: Mailer = { send: vi.fn().mockRejectedValue(new Error('smtp down')) };
    const provider = new SandboxSmsProvider({ mailer, mailbox: 'sms-sandbox@ghmt.local' });

    await expect(provider.send(REQUEST)).resolves.toMatchObject({ providerMessageId: expect.stringMatching(/^sbx-/) });
  });
});

describe('UnavailableSmsProvider', () => {
  it('refuse tout envoi avec une erreur de configuration', async () => {
    const error = await failureOf(new UnavailableSmsProvider().send(REQUEST));

    expect(error.errorClass).toBe('permanent_config');
    expect(error.errorCode).toBe('provider_unavailable');
  });
});

describe('createSmsProvider', () => {
  const base = { NODE_ENV: 'test', SMS_PROVIDER: 'none', SMS_SANDBOX_MAILBOX: 'sms-sandbox@ghmt.local', SMS_HTTP_SENDER_ID: 'GHMT', SMS_HTTP_TIMEOUT_MS: 10_000 } as unknown as Env;
  const mailer: Mailer = { send: vi.fn() };

  it('retourne l’adaptateur correspondant à SMS_PROVIDER', () => {
    expect(createSmsProvider(base, mailer, vi.fn()).name).toBe('none');
    expect(createSmsProvider({ ...base, SMS_PROVIDER: 'sandbox' }, mailer, vi.fn()).name).toBe('sandbox');
    const http = createSmsProvider({ ...base, SMS_PROVIDER: 'http', SMS_HTTP_URL: CONFIG.url, SMS_HTTP_TOKEN: CONFIG.token }, mailer, vi.fn());
    expect(http.name).toBe('http');
  });

  it('refuse un adaptateur http sans URL ni jeton (échec au démarrage)', () => {
    expect(() => createSmsProvider({ ...base, SMS_PROVIDER: 'http' }, mailer, vi.fn())).toThrow(/SMS_HTTP/);
  });

  it('refuse le sandbox en production', () => {
    expect(() => createSmsProvider({ ...base, NODE_ENV: 'production', SMS_PROVIDER: 'sandbox' }, mailer, vi.fn())).toThrow(/sandbox/);
  });
});
