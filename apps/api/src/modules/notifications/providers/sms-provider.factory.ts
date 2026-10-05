import type { Mailer } from '../../../common/mail/mailer';
import type { Env } from '../../../infrastructure/config/env';
import { HttpSmsProvider } from './http-sms.provider';
import { SandboxSmsProvider } from './sandbox-sms.provider';
import { UnavailableSmsProvider, type SmsProvider } from './sms-provider';

/**
 * Choisit l'adaptateur selon `SMS_PROVIDER` (docs/10 D5). Défense en profondeur de la validation de l'environnement :
 * `sandbox` refusé en production, `http` sans URL ni jeton refusé (échec au démarrage).
 */
export function createSmsProvider(env: Env, mailer: Mailer, fetchImpl: typeof fetch): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case 'sandbox': {
      if (env.NODE_ENV === 'production') throw new Error('Configuration invalide : le fournisseur SMS sandbox est interdit en production.');
      // La copie vers Mailpit n'existe qu'en développement : les tests restent hermétiques.
      const copy = env.NODE_ENV === 'development' ? { mailer, mailbox: env.SMS_SANDBOX_MAILBOX } : undefined;
      return new SandboxSmsProvider(copy);
    }
    case 'http': {
      if (!env.SMS_HTTP_URL || !env.SMS_HTTP_TOKEN) throw new Error('Configuration invalide : SMS_HTTP_URL et SMS_HTTP_TOKEN sont requis avec SMS_PROVIDER=http.');
      return new HttpSmsProvider({ url: env.SMS_HTTP_URL, token: env.SMS_HTTP_TOKEN, senderId: env.SMS_HTTP_SENDER_ID, timeoutMs: env.SMS_HTTP_TIMEOUT_MS }, fetchImpl);
    }
    default:
      return new UnavailableSmsProvider();
  }
}
