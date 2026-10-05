import { recordConsentAction } from '@/actions/patient-consents';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { CONSENT_CHANNEL_LABELS, CONSENT_SOURCE_LABELS, type ConsentState, type ContactConsentsView } from '@/lib/domain/notifications';
import { formatDateTime } from '@/lib/format/dates';

export interface ContactConsentsProps {
  readonly patientId: string;
  readonly consents: ContactConsentsView;
  readonly canUpdate: boolean;
  readonly timeZone: string;
}

function stateText(state: ConsentState, timeZone: string): string {
  if (!state.recordedAt) return 'Jamais recueilli';
  const source = state.source ? ` (${CONSENT_SOURCE_LABELS[state.source] ?? state.source})` : '';
  return `${state.granted ? 'Accordé' : 'Refusé'} le ${formatDateTime(state.recordedAt, timeZone)}${source}`;
}

function ChannelRow({ patientId, state, canUpdate, timeZone }: { readonly patientId: string; readonly state: ConsentState; readonly canUpdate: boolean; readonly timeZone: string }) {
  const label = CONSENT_CHANNEL_LABELS[state.channel];
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-sm text-slate-800">{stateText(state, timeZone)}</p>
        <Badge tone={state.granted ? 'success' : 'neutral'}>{state.granted ? 'Rappels autorisés' : 'Rappels non autorisés'}</Badge>
      </div>
      {canUpdate ? (
        <ActionForm
          action={recordConsentAction}
          fields={[]}
          hidden={{ patientId, channel: state.channel, granted: state.granted ? 'false' : 'true' }}
          submitLabel={state.granted ? `Révoquer le consentement ${label}` : `Accorder le consentement ${label}`}
          pendingLabel="…"
          variant={state.granted ? 'secondary' : 'primary'}
          idPrefix={`consent-${state.channel}-`}
        />
      ) : null}
    </li>
  );
}

/** Bloc « Rappels de rendez-vous » de la fiche patient : consentement explicite par canal (docs/10 §9.2, §5.6). */
export function ContactConsents({ patientId, consents, canUpdate, timeZone }: ContactConsentsProps) {
  return (
    <section aria-labelledby="rappels-rdv" className="mt-6 rounded-md border border-slate-300 bg-white p-4">
      <h2 id="rappels-rdv" className="text-lg font-semibold">Rappels de rendez-vous</h2>
      <p className="mt-1 text-sm text-slate-800">
        Les rappels envoyés avant un rendez-vous exigent l&apos;accord explicite du patient pour chaque canal. Les messages ne contiennent aucune information de santé.
      </p>
      <ul className="divide-y divide-slate-200">
        {consents.current.map((state) => (
          <ChannelRow key={state.channel} patientId={patientId} state={state} canUpdate={canUpdate} timeZone={timeZone} />
        ))}
      </ul>
      {consents.history.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-medium text-blue-800 underline">Historique des consentements</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {consents.history.map((entry) => (
              <li key={entry.id}>
                {CONSENT_CHANNEL_LABELS[entry.channel]} : {entry.granted ? 'accordé' : 'refusé'}
                {entry.recordedAt ? ` le ${formatDateTime(entry.recordedAt, timeZone)}` : ''}
                {entry.source ? ` (${CONSENT_SOURCE_LABELS[entry.source] ?? entry.source})` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
