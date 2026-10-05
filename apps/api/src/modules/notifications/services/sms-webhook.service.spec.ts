import { describe, expect, it } from 'vitest';
import type { Env } from '../../../infrastructure/config/env';
import { SmsWebhookService } from './sms-webhook.service';

type SandboxEnv = Pick<Env, 'SMS_PROVIDER' | 'SMS_SANDBOX_WEBHOOKS_ENABLED'>;

/** Seul l'environnement validé compte : `process.env` n'est pas encore chargé quand les modules sont évalués. */
function serviceWith(env: SandboxEnv): SmsWebhookService {
  const unused = {} as never;
  return new SmsWebhookService(unused, unused, unused, unused, unused, env as Env);
}

describe('SmsWebhookService.assertSandbox', () => {
  it('autorise les routes sandbox quand le fournisseur est le sandbox et que les webhooks sont activés', () => {
    expect(() => serviceWith({ SMS_PROVIDER: 'sandbox', SMS_SANDBOX_WEBHOOKS_ENABLED: true }).assertSandbox()).not.toThrow();
  });

  it('répond 404 quand les webhooks sandbox ne sont pas activés, même avec le fournisseur sandbox', () => {
    expect(() => serviceWith({ SMS_PROVIDER: 'sandbox', SMS_SANDBOX_WEBHOOKS_ENABLED: false }).assertSandbox()).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('répond 404 quand le fournisseur actif n’est pas le sandbox', () => {
    expect(() => serviceWith({ SMS_PROVIDER: 'http', SMS_SANDBOX_WEBHOOKS_ENABLED: true }).assertSandbox()).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});
