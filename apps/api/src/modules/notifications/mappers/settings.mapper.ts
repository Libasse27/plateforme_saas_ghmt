import type { NotificationSettings } from '../../../generated/prisma/client';

/** Réglages effectifs d'un établissement : la ligne de `notification_settings`, ou les valeurs par défaut du contrat. */
export interface EffectiveSettings {
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  readonly smsTransliterate: boolean;
  readonly senderDisplayName: string | null;
  readonly appointmentSmsEnabled: boolean;
  readonly reminderD1Enabled: boolean;
  readonly reminderD1LocalTime: string;
  readonly reminderH2Enabled: boolean;
  readonly updatedAt: Date | null;
}

export const DEFAULT_SETTINGS: EffectiveSettings = {
  quietHoursStart: '21:00',
  quietHoursEnd: '07:00',
  smsTransliterate: true,
  senderDisplayName: null,
  appointmentSmsEnabled: true,
  reminderD1Enabled: true,
  reminderD1LocalTime: '10:00',
  reminderH2Enabled: true,
  updatedAt: null,
};

/** Une colonne `time` revient de Prisma comme un `Date` (1970-01-01, UTC) : on en tire `HH:MM`. */
export const timeToHhmm = (value: Date): string => value.toISOString().slice(11, 16);
export const hhmmToTime = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

export function toEffectiveSettings(row: NotificationSettings | null): EffectiveSettings {
  if (!row) return DEFAULT_SETTINGS;
  return {
    quietHoursStart: timeToHhmm(row.quietHoursStart),
    quietHoursEnd: timeToHhmm(row.quietHoursEnd),
    smsTransliterate: row.smsTransliterate,
    senderDisplayName: row.senderDisplayName,
    appointmentSmsEnabled: row.appointmentSmsEnabled,
    reminderD1Enabled: row.reminderD1Enabled,
    reminderD1LocalTime: timeToHhmm(row.reminderD1LocalTime),
    reminderH2Enabled: row.reminderH2Enabled,
    updatedAt: row.updatedAt,
  };
}
