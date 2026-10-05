'use server';

import { revalidatePath } from 'next/cache';
import { num, rec } from '@/lib/domain/raw';
import { formDataToFlat, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { INVALID_REQUEST, pathId } from './context';
import { failureState } from './helpers';

const INBOX_PATH = '/notifications';
const PREFERENCES_PATH = '/notifications/preferences';
const PREFERENCE_CATEGORIES: ReadonlySet<string> = new Set(['administrative']);
const PREFERENCE_CHANNELS: ReadonlySet<string> = new Set(['email', 'inapp']);

/** Le compteur de la cloche vit dans le layout : il doit être revalidé avec la boîte. */
function refreshInbox(): void {
  revalidatePath(INBOX_PATH);
  revalidatePath('/', 'layout');
}

export async function markReadAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = pathId(formDataToFlat(formData).id);
  if (!id) return INVALID_REQUEST;
  try {
    await actionApi(`/notifications/inbox/${id}/read`, { method: 'POST' });
  } catch (error) {
    return failureState(error);
  }
  refreshInbox();
  return { ok: true, message: 'Notification marquée comme lue.' };
}

export async function markAllReadAction(): Promise<FormState> {
  let updated = 0;
  try {
    updated = num(rec((await actionApi('/notifications/inbox/read-all', { method: 'POST' })).data).updated);
  } catch (error) {
    return failureState(error);
  }
  refreshInbox();
  return { ok: true, message: updated > 0 ? `${String(updated)} notification${updated > 1 ? 's' : ''} marquée${updated > 1 ? 's' : ''} comme lue${updated > 1 ? 's' : ''}.` : 'Aucune notification non lue.' };
}

interface PreferenceEntry {
  readonly category: string;
  readonly channel: string;
  readonly enabled: boolean;
}

/** Préférences modifiables listées dans `known` (« catégorie:canal »), activées si leur case est cochée. */
function preferencesFrom(flat: Readonly<Record<string, string>>): PreferenceEntry[] {
  return (flat.known ?? '')
    .split(',')
    .map((key) => key.split(':'))
    .filter((parts): parts is [string, string] => parts.length === 2 && PREFERENCE_CATEGORIES.has(parts[0] ?? '') && PREFERENCE_CHANNELS.has(parts[1] ?? ''))
    .map(([category, channel]) => ({ category, channel, enabled: flat[`pref.${category}:${channel}`] !== undefined }));
}

export async function updatePreferencesAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const items = preferencesFrom(formDataToFlat(formData));
  if (items.length === 0) return INVALID_REQUEST;
  try {
    await actionApi('/notifications/preferences', { method: 'PUT', body: { items } });
  } catch (error) {
    return failureState(error);
  }
  revalidatePath(PREFERENCES_PATH);
  return { ok: true, message: 'Préférences enregistrées.' };
}
