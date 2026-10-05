'use client';

import { useActionState } from 'react';
import { updatePreferencesAction } from '@/actions/notifications';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { PREFERENCE_LABELS, type NotificationPreferenceView } from '@/lib/domain/notifications';
import { EMPTY_FORM_STATE } from '@/lib/forms';

const keyOf = (preference: NotificationPreferenceView): string => `${preference.category}:${preference.channel}`;

function PreferenceRow({ preference }: { readonly preference: NotificationPreferenceView }) {
  const key = keyOf(preference);
  const id = `pref-${key.replace(':', '-')}`;
  const noteId = `${id}-note`;
  const note = preference.locked ? 'Verrouillée : toujours activée.' : preference.note;
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        name={`pref.${key}`}
        defaultChecked={preference.enabled}
        disabled={preference.locked}
        aria-describedby={note ? noteId : undefined}
        className="mt-1 h-4 w-4"
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-slate-900">{PREFERENCE_LABELS.channels[preference.channel] ?? preference.channel}</label>
        {note ? <p id={noteId} className="text-sm text-slate-700">{note}</p> : null}
      </div>
    </div>
  );
}

function groupByCategory(preferences: readonly NotificationPreferenceView[]): [string, NotificationPreferenceView[]][] {
  const groups = new Map<string, NotificationPreferenceView[]>();
  for (const preference of preferences) groups.set(preference.category, [...(groups.get(preference.category) ?? []), preference]);
  return [...groups.entries()];
}

export function PreferencesForm({ preferences }: { readonly preferences: readonly NotificationPreferenceView[] }) {
  const [state, formAction] = useActionState(updatePreferencesAction, EMPTY_FORM_STATE);
  if (preferences.length === 0) return <p className="text-slate-700">Aucune préférence configurable.</p>;
  const editable = preferences.filter((preference) => !preference.locked);
  return (
    <form action={formAction} className="space-y-4">
      <FormMessage state={state} />
      <input type="hidden" name="known" value={editable.map(keyOf).join(',')} />
      {groupByCategory(preferences).map(([category, entries]) => (
        <fieldset key={category} className="space-y-3 rounded-md border border-slate-300 bg-white p-4">
          <legend className="px-1 font-semibold">{PREFERENCE_LABELS.categories[category] ?? category}</legend>
          {entries.map((preference) => (
            <PreferenceRow key={keyOf(preference)} preference={preference} />
          ))}
        </fieldset>
      ))}
      {editable.length > 0 ? <SubmitButton pendingLabel="Enregistrement…">Enregistrer</SubmitButton> : null}
    </form>
  );
}
