import { Injectable } from '@nestjs/common';
import type { NotificationChannel, NotificationLocale, NotificationTypeCode } from '@ghmt/shared';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { analyzeSms, type SmsAnalysis } from '../domain/sms-encoding';
import { TemplateRenderError, renderTemplate, toEmailHtml } from '../domain/template-engine';
import { TemplatesRepository } from '../repositories/templates.repository';
import { resolveDefaultTemplate } from '../templates/default-templates';

export interface ComposeInput {
  readonly typeCode: NotificationTypeCode;
  readonly channel: NotificationChannel;
  readonly locale: NotificationLocale;
  readonly values: Readonly<Record<string, string>>;
  readonly transliterate: boolean;
}

export interface ComposedMessage {
  /** Sujet d'e-mail ou titre in-app ; `null` pour un SMS. */
  readonly subject: string | null;
  readonly text: string;
  readonly html: string | null;
  readonly templateSource: 'default' | 'custom';
  readonly templateVersion: number;
  /** Encodage et segments d'un SMS (le texte envoyé est `text`, déjà translittéré si demandé). */
  readonly sms: SmsAnalysis | null;
}

interface ResolvedTemplate {
  readonly source: 'default' | 'custom';
  readonly version: number;
  readonly subject: string | null;
  readonly body: string;
}

/**
 * Chaîne de repli de D11 : modèle personnalisé actif de la langue, puis modèle par défaut de la langue, puis français.
 * Rendu strict : une valeur manquante lève `TemplateRenderError` (le message n'est jamais envoyé incomplet).
 */
@Injectable()
export class MessageComposer {
  constructor(private readonly templates: TemplatesRepository) {}

  async compose(tx: TenantTx, tenantId: string, input: ComposeInput): Promise<ComposedMessage> {
    const template = await this.resolve(tx, tenantId, input);
    const subject = template.subject === null ? null : renderTemplate(template.subject, input.values);
    const rendered = renderTemplate(template.body, input.values);
    const sms = input.channel === 'sms' ? analyzeSms(rendered, { transliterate: input.transliterate }) : null;
    return {
      subject,
      text: sms ? sms.text : rendered,
      html: input.channel === 'email' ? toEmailHtml(rendered) : null,
      templateSource: template.source,
      templateVersion: template.version,
      sms,
    };
  }

  private async resolve(tx: TenantTx, tenantId: string, input: ComposeInput): Promise<ResolvedTemplate> {
    const custom = await this.templates.findActive(tx, tenantId, { typeCode: input.typeCode, channel: input.channel, locale: input.locale });
    if (custom) return { source: 'custom', version: custom.version, subject: custom.subject, body: custom.body };
    const fallback = resolveDefaultTemplate(input.typeCode, input.channel, input.locale);
    if (!fallback) throw new TemplateRenderError(`${input.typeCode}/${input.channel}`);
    return { source: 'default', version: fallback.version, subject: fallback.subject, body: fallback.body };
  }
}
