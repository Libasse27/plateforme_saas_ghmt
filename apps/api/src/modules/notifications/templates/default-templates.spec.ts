import { NOTIFICATION_LOCALES, NOTIFICATION_TYPES, NOTIFICATION_TYPE_CODES, type NotificationTypeCode } from '@ghmt/shared';
import { describe, expect, it } from 'vitest';
import { extractVariables } from '../domain/template-engine';
import { lintTemplate } from '../domain/template-linter';
import { DEFAULT_TEMPLATES, findDefaultTemplate, resolveDefaultTemplate } from './default-templates';

const everyCombination = NOTIFICATION_TYPE_CODES.flatMap((typeCode) =>
  NOTIFICATION_TYPES[typeCode].channels.flatMap((channel) => NOTIFICATION_LOCALES.map((locale) => ({ typeCode, channel, locale }))),
);

describe('modèles par défaut', () => {
  it('couvrent chaque type × canal × langue du catalogue, une seule fois', () => {
    expect(everyCombination).toHaveLength(40);
    expect(DEFAULT_TEMPLATES).toHaveLength(everyCombination.length);
    for (const combination of everyCombination) {
      expect(DEFAULT_TEMPLATES.filter((t) => t.typeCode === combination.typeCode && t.channel === combination.channel && t.locale === combination.locale)).toHaveLength(1);
    }
  });

  it.each(everyCombination)('$typeCode / $channel / $locale respecte le linter de confidentialité (CI)', ({ typeCode, channel, locale }) => {
    const template = findDefaultTemplate(typeCode, channel, locale);
    expect(template).toBeDefined();

    for (const transliterate of [true, false]) {
      const issues = lintTemplate({ typeCode, channel, subject: template?.subject ?? undefined, body: template?.body ?? '', serviceNames: [], transliterate });
      expect(issues, JSON.stringify(issues)).toEqual([]);
    }
  });

  it('porte une version entière positive et un sujet seulement hors SMS', () => {
    for (const template of DEFAULT_TEMPLATES) {
      expect(Number.isInteger(template.version) && template.version >= 1).toBe(true);
      expect(template.subject === null).toBe(template.channel === 'sms');
    }
  });

  it('n’utilise que des variables de la liste blanche de son type', () => {
    for (const template of DEFAULT_TEMPLATES) {
      const allowed: readonly string[] = NOTIFICATION_TYPES[template.typeCode as NotificationTypeCode].variables;
      const used = [...extractVariables(template.body), ...extractVariables(template.subject ?? '')];
      expect(used.filter((name) => !allowed.includes(name))).toEqual([]);
    }
  });

  it('les rappels SMS expliquent comment se désinscrire (STOP)', () => {
    expect(findDefaultTemplate('appointment.reminder_d1', 'sms', 'fr')?.body).toContain('STOP');
    expect(findDefaultTemplate('appointment.reminder_h2', 'sms', 'en')?.body).toContain('STOP');
  });
});

describe('resolveDefaultTemplate', () => {
  it('retourne le modèle de la langue demandée', () => {
    expect(resolveDefaultTemplate('appointment.confirmed', 'sms', 'en')?.locale).toBe('en');
  });

  it('se rabat sur le français quand la langue n’existe pas', () => {
    expect(resolveDefaultTemplate('appointment.confirmed', 'sms', 'es' as never)?.locale).toBe('fr');
  });

  it('retourne undefined pour une combinaison absente du catalogue', () => {
    expect(resolveDefaultTemplate('subscription.invoice_issued', 'sms', 'fr')).toBeUndefined();
  });
});
