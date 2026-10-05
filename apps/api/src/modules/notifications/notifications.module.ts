import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MAILER, type Mailer } from '../../common/mail/mailer';
import { ENV, type Env } from '../../infrastructure/config/env';
import { ConsentsController } from './controllers/consents.controller';
import { DeliveriesController } from './controllers/deliveries.controller';
import { InboxController } from './controllers/inbox.controller';
import { SettingsController } from './controllers/settings.controller';
import { SmsWebhooksController } from './controllers/sms-webhooks.controller';
import { TemplatesController } from './controllers/templates.controller';
import { NotificationRetentionJob } from './jobs/notification-retention.job';
import { ReminderSweeperJob } from './jobs/reminder-sweeper.job';
import { SaasDunningJob } from './jobs/saas-dunning.job';
import { createSmsProvider } from './providers/sms-provider.factory';
import { SMS_PROVIDER_TOKEN } from './providers/sms-provider';
import { ConsentsRepository } from './repositories/consents.repository';
import { InboxRepository } from './repositories/inbox.repository';
import { NotificationsRepository } from './repositories/notifications.repository';
import { OutboxRepository } from './repositories/outbox.repository';
import { RecipientsRepository } from './repositories/recipients.repository';
import { SettingsRepository } from './repositories/settings.repository';
import { TemplatesRepository } from './repositories/templates.repository';
import { AppointmentPlanningService } from './services/appointment-planning.service';
import { ChannelSender } from './services/channel-sender';
import { ConsentsService } from './services/consents.service';
import { DeliveriesService } from './services/deliveries.service';
import { DeliveryPreparer } from './services/delivery-preparer';
import { DeliveryRecorder } from './services/delivery-recorder';
import { InboxService } from './services/inbox.service';
import { MessageComposer } from './services/message-composer';
import { NotificationDeliveryService } from './services/notification-delivery.service';
import { NotificationDispatcher } from './services/notification-dispatcher';
import { NotificationWorker } from './services/notification-worker';
import { OutboxRelayService } from './services/outbox-relay.service';
import { PreferencesService } from './services/preferences.service';
import { QuotaAlertService } from './services/quota-alert.service';
import { RecipientHasher } from './services/recipient-hasher';
import { SaasPaymentSubscriber } from './services/saas-payment.subscriber';
import { SettingsService } from './services/settings.service';
import { SmsQuotaService } from './services/sms-quota.service';
import { SmsStopService } from './services/sms-stop.service';
import { SmsWebhookService } from './services/sms-webhook.service';
import { SmsRecipientRegistry } from './services/sms-recipient-registry';
import { TemplatesService } from './services/templates.service';

const REPOSITORIES = [ConsentsRepository, InboxRepository, NotificationsRepository, OutboxRepository, RecipientsRepository, SettingsRepository, TemplatesRepository];

const DELIVERY_PIPELINE = [
  AppointmentPlanningService,
  ChannelSender,
  ConsentsService,
  DeliveriesService,
  DeliveryPreparer,
  DeliveryRecorder,
  InboxService,
  MessageComposer,
  NotificationDeliveryService,
  NotificationDispatcher,
  NotificationWorker,
  OutboxRelayService,
  PreferencesService,
  QuotaAlertService,
  RecipientHasher,
  SaasPaymentSubscriber,
  SettingsService,
  SmsQuotaService,
  SmsRecipientRegistry,
  SmsStopService,
  SmsWebhookService,
  TemplatesService,
];

const JOBS = [NotificationRetentionJob, ReminderSweeperJob, SaasDunningJob];

/** Notifications : outbox, dispatcher, canaux, rappels et relances (docs/10 §5). */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [InboxController, SettingsController, TemplatesController, DeliveriesController, ConsentsController, SmsWebhooksController],
  providers: [
    { provide: SMS_PROVIDER_TOKEN, inject: [ENV, MAILER], useFactory: (env: Env, mailer: Mailer) => createSmsProvider(env, mailer, fetch) },
    ...REPOSITORIES,
    ...DELIVERY_PIPELINE,
    ...JOBS,
  ],
  exports: [NotificationDispatcher],
})
export class NotificationsModule {}
