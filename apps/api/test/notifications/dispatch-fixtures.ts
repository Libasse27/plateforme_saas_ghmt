import type { INestApplication } from '@nestjs/common';
import { SandboxSmsProvider } from '../../src/modules/notifications/providers/sandbox-sms.provider';
import { SMS_PROVIDER_TOKEN } from '../../src/modules/notifications/providers/sms-provider';
import { NotificationDispatcher } from '../../src/modules/notifications/services/notification-dispatcher';
import type { TenantFixture } from '../helpers/fixtures';

export const sandboxOf = (app: INestApplication): SandboxSmsProvider => app.get<SandboxSmsProvider>(SMS_PROVIDER_TOKEN);

/** Une passe du dispatcher restreinte à un établissement de test (l'horloge est celle de l'appelant). */
export const runDispatcher = (app: INestApplication, now: Date, tenant: Pick<TenantFixture, 'tenantId'>): ReturnType<NotificationDispatcher['runOnce']> =>
  app.get(NotificationDispatcher).runOnce(now, { tenantIds: [tenant.tenantId] });
