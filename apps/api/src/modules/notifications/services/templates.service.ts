import { Injectable } from '@nestjs/common';
import {
  NOTIFICATION_LOCALES,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_CODES,
  type NotificationChannel,
  type NotificationLocale,
  type NotificationTemplateView,
  type NotificationTypeCode,
  type PreviewNotificationTemplateInput,
  type TemplatePreviewView,
  type UpsertNotificationTemplateInput,
} from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { SAMPLE_VALUES } from '../domain/sample-values';
import { analyzeSms } from '../domain/sms-encoding';
import { renderLenient } from '../domain/template-engine';
import { lintTemplate, type TemplateIssue } from '../domain/template-linter';
import { customTemplateView, defaultTemplateView, type TemplateKeyParts } from '../mappers/template.mapper';
import { RecipientsRepository } from '../repositories/recipients.repository';
import { SettingsRepository } from '../repositories/settings.repository';
import { TemplatesRepository } from '../repositories/templates.repository';
import { findDefaultTemplate } from '../templates/default-templates';

const notFound = (): DomainError => new DomainError('template_not_found', 404, 'Not Found', 'Modèle introuvable.');

/** Modèles : défauts versionnés en code, surcharges du tenant versionnées en base (docs/10 D12), linter bloquant (§5.4). */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: TemplatesRepository,
    private readonly recipients: RecipientsRepository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  /** Modèle EFFECTIF de chaque combinaison du catalogue : surcharge active, à défaut modèle par défaut. */
  list(typeCode?: NotificationTypeCode): Promise<NotificationTemplateView[]> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const customs = await this.repo.listActive(tx, tenantId, typeCode);
      const byKey = new Map(customs.map((row) => [`${row.typeCode}/${row.channel}/${row.locale}`, row]));
      return combinationsOf(typeCode).flatMap((key) => {
        const custom = byKey.get(`${key.typeCode}/${key.channel}/${key.locale}`);
        if (custom) return [customTemplateView(key, custom)];
        const fallback = findDefaultTemplate(key.typeCode, key.channel, key.locale);
        return fallback ? [defaultTemplateView(key, fallback)] : [];
      });
    });
  }

  upsert(rawType: string, rawChannel: string, rawLocale: string, input: UpsertNotificationTemplateInput): Promise<NotificationTemplateView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const key = parseKey(rawType, rawChannel, rawLocale);
    return this.db.run(async (tx) => {
      const issues = await this.lint(tx, tenantId, key, input.subject, input.body);
      if (issues.length > 0) throw rejected(issues);
      const row = await this.repo.publish(tx, tenantId, key, { subject: input.subject?.trim() ? input.subject : null, body: input.body, createdBy: userId });
      await this.audit.record(tx, tenantId, { action: 'notification.template_updated', resourceType: 'notification_template', resourceId: row.id, changes: { ...key, version: row.version } });
      return customTemplateView(key, row);
    });
  }

  remove(rawType: string, rawChannel: string, rawLocale: string): Promise<void> {
    const { tenantId } = this.context.requirePrincipal();
    const key = parseKey(rawType, rawChannel, rawLocale);
    return this.db.run(async (tx) => {
      const active = await this.repo.findActive(tx, tenantId, key);
      if (!active) throw notFound();
      await this.repo.deactivate(tx, tenantId, key);
      await this.audit.record(tx, tenantId, { action: 'notification.template_reset', resourceType: 'notification_template', resourceId: active.id, changes: { ...key, version: active.version } });
    });
  }

  /** Aperçu avec des valeurs d'exemple de longueur maximale ; répond même si le linter signale des problèmes. */
  preview(input: PreviewNotificationTemplateInput): Promise<TemplatePreviewView> {
    const { tenantId } = this.context.requirePrincipal();
    const key: TemplateKeyParts = { typeCode: input.typeCode, channel: input.channel, locale: input.locale };
    if (!(NOTIFICATION_TYPES[key.typeCode].channels as readonly NotificationChannel[]).includes(key.channel)) {
      throw DomainError.validation([{ path: 'channel', code: 'unsupported_channel', message: 'Ce canal n’existe pas pour ce type de message.' }]);
    }
    return this.db.run(async (tx) => {
      const issues = await this.lint(tx, tenantId, key, input.subject, input.body);
      const settings = await this.settings.load(tx, tenantId);
      const rendered = renderLenient(input.body, SAMPLE_VALUES);
      const sms = key.channel === 'sms' ? analyzeSms(rendered, { transliterate: settings.smsTransliterate }) : null;
      const body = sms ? sms.text : rendered;
      return {
        subject: input.subject === undefined || input.subject === '' ? null : renderLenient(input.subject, SAMPLE_VALUES),
        body,
        characters: Array.from(body).length,
        segments: sms?.segments ?? null,
        encoding: sms?.encoding ?? null,
        issues,
      };
    });
  }

  private async lint(tx: TenantTx, tenantId: string, key: TemplateKeyParts, subject: string | undefined, body: string): Promise<TemplateIssue[]> {
    const serviceNames = await this.recipients.departmentNames(tx, tenantId);
    const settings = await this.settings.load(tx, tenantId);
    return lintTemplate({ ...key, subject, body, serviceNames, transliterate: settings.smsTransliterate });
  }
}

function combinationsOf(typeCode?: NotificationTypeCode): TemplateKeyParts[] {
  const codes = typeCode ? [typeCode] : NOTIFICATION_TYPE_CODES;
  return codes.flatMap((code) => NOTIFICATION_TYPES[code].channels.flatMap((channel) => NOTIFICATION_LOCALES.map((locale) => ({ typeCode: code, channel, locale }))));
}

/** Combinaison absente du catalogue ⇒ 404 `template_not_found`. */
function parseKey(typeCode: string, channel: string, locale: string): TemplateKeyParts {
  const definition = (NOTIFICATION_TYPES as Record<string, (typeof NOTIFICATION_TYPES)[NotificationTypeCode] | undefined>)[typeCode];
  const knownChannel = definition?.channels.find((candidate) => candidate === channel);
  const knownLocale = NOTIFICATION_LOCALES.find((candidate) => candidate === locale);
  if (!definition || !knownChannel || !knownLocale) throw notFound();
  return { typeCode: typeCode as NotificationTypeCode, channel: knownChannel as NotificationChannel, locale: knownLocale as NotificationLocale };
}

function rejected(issues: readonly TemplateIssue[]): DomainError {
  const errors = issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message }));
  return new DomainError('template_rejected', 422, 'Unprocessable Entity', 'Le modèle est refusé par le contrôle de confidentialité.', { errors });
}
