import type { Metadata } from 'next';
import { closeSessionAction, createRegisterAction, openSessionAction } from '@/actions/cashier';
import { SessionsTable } from '@/components/cashier/SessionsTable';
import { ActionForm } from '@/components/forms/ActionForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { settle } from '@/lib/api/settle';
import { canUse } from '@/lib/auth/me';
import { toCashRegister, toCashSession } from '@/lib/domain/billing';
import { toList, toSite } from '@/lib/domain/mappers';
import { formatMoney } from '@/lib/domain/money';
import { items } from '@/lib/domain/raw';
import { formatDateTime } from '@/lib/format/dates';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Caisse' };

const SESSIONS_LIMIT = 10;
const TO_VALIDATE_LIMIT = 50;

export default async function CashierPage() {
  const me = await requireMe();
  if (!canUse(me, 'cashier', 'cashier:cash_session:read')) return <AccessDenied what="la caisse" />;
  const canOpen = canUse(me, 'cashier', 'cashier:cash_session:create');
  const canValidate = canUse(me, 'cashier', 'cashier:cash_session:validate');
  const tz = me.tenant.timezone;

  const [registersResult, mineResult, toValidateResult, sitesResult] = await Promise.all([
    settle(() => pageApi('/cashier/registers')),
    settle(() => pageApi('/cashier/sessions', { query: { mine: true, limit: SESSIONS_LIMIT } })),
    canValidate ? settle(() => pageApi('/cashier/sessions', { query: { status: 'closed', limit: TO_VALIDATE_LIMIT } })) : Promise.resolve(null),
    canValidate ? settle(() => pageApi('/org/sites')) : Promise.resolve(null),
  ]);
  if (!registersResult.ok) return <Alert tone="error">{registersResult.message}</Alert>;

  const registers = items(registersResult.value.data, toCashRegister).filter((r) => r.isActive);
  const registerNames = Object.fromEntries(items(registersResult.value.data, toCashRegister).map((r) => [r.id, r.name]));
  const mine = mineResult.ok ? items(mineResult.value.data, toCashSession) : [];
  const current = mine.find((session) => session.status === 'open');
  const toValidate = toValidateResult?.ok ? items(toValidateResult.value.data, toCashSession) : [];
  const sites = sitesResult?.ok ? toList(sitesResult.value.data, toSite) : [];

  return (
    <>
      <PageHeader title="Caisse" description="Ouverture, encaissements en espèces, clôture et validation des sessions." />
      <div className="space-y-8">
        <section aria-labelledby="session-courante" className="rounded-md border border-slate-300 bg-white p-4">
          <h2 id="session-courante" className="mb-3 text-lg font-semibold">Ma session en cours</h2>
          {current ? (
            <div className="space-y-4">
              <dl className="grid gap-3 sm:grid-cols-3">
                <div><dt className="text-sm text-slate-700">Caisse</dt><dd className="font-medium">{registerNames[current.cashRegisterId] ?? 'Caisse'}</dd></div>
                <div><dt className="text-sm text-slate-700">Ouverte le</dt><dd className="font-medium">{formatDateTime(current.openedAt, tz)}</dd></div>
                <div><dt className="text-sm text-slate-700">Fond de caisse</dt><dd className="font-medium">{formatMoney(current.openingFloat, current.currency)}</dd></div>
              </dl>
              <p>Espèces attendues à cet instant : <strong>{formatMoney(current.expectedTotal, current.currency)}</strong></p>
              <h3 className="font-semibold">Clôturer la session</h3>
              <p className="text-sm text-slate-800">Comptez les espèces : l&apos;écart avec le montant attendu sera affiché après la clôture.</p>
              <ActionForm
                action={closeSessionAction}
                idPrefix="close-"
                hidden={{ sessionId: current.id }}
                fields={[
                  { kind: 'text', name: 'countedAmount', label: `Montant compté (${current.currency})`, required: true, inputMode: 'decimal' },
                  { kind: 'text', name: 'note', label: 'Note (facultative)' },
                ]}
                submitLabel="Clôturer la session"
                pendingLabel="Clôture…"
              />
            </div>
          ) : canOpen ? (
            registers.length === 0 ? (
              <Alert tone="warning">Aucune caisse n&apos;est configurée.{canValidate ? ' Créez-en une ci-dessous.' : ' Demandez à un responsable d\'en créer une.'}</Alert>
            ) : (
              <>
                <p className="mb-3 text-slate-800">Vous n&apos;avez pas de session ouverte. Ouvrez-en une pour encaisser en espèces.</p>
                <ActionForm
                  action={openSessionAction}
                  idPrefix="open-"
                  fields={[
                    { kind: 'select', name: 'cashRegisterId', label: 'Caisse', required: true, options: registers.map((r) => ({ value: r.id, label: r.name })), placeholder: 'Choisir une caisse…' },
                    { kind: 'text', name: 'openingFloat', label: 'Fond de caisse', required: true, inputMode: 'decimal', defaultValue: '0', hint: 'Espèces présentes dans le tiroir à l\'ouverture.' },
                  ]}
                  submitLabel="Ouvrir la session"
                  pendingLabel="Ouverture…"
                />
              </>
            )
          ) : (
            <p className="text-slate-700">Vous n&apos;avez pas le droit d&apos;ouvrir une session de caisse.</p>
          )}
        </section>

        <section aria-labelledby="mes-sessions">
          <h2 id="mes-sessions" className="mb-3 text-lg font-semibold">Mes dernières sessions</h2>
          {mineResult.ok ? <SessionsTable sessions={mine} registerNames={registerNames} timeZone={tz} caption="Mes sessions de caisse" /> : <Alert tone="error">{mineResult.message}</Alert>}
        </section>

        {canValidate ? (
          <section aria-labelledby="a-valider">
            <h2 id="a-valider" className="mb-3 text-lg font-semibold">Sessions à valider</h2>
            <p className="mb-3 text-sm text-slate-800">La validation doit être faite par un autre utilisateur que celui qui a ouvert ou clôturé la session.</p>
            {toValidateResult?.ok ? (
              <SessionsTable sessions={toValidate} registerNames={registerNames} timeZone={tz} caption="Sessions clôturées à valider" currentUserId={me.user.id} canValidate />
            ) : (
              <Alert tone="error">{toValidateResult?.ok === false ? toValidateResult.message : 'Chargement impossible.'}</Alert>
            )}
          </section>
        ) : null}

        <section aria-labelledby="caisses">
          <h2 id="caisses" className="mb-3 text-lg font-semibold">Caisses du site</h2>
          {registers.length === 0 ? (
            <p className="text-slate-700">Aucune caisse.</p>
          ) : (
            <ul className="list-inside list-disc">
              {registers.map((r) => (
                <li key={r.id}>{r.name} <span className="text-slate-700">({r.code})</span></li>
              ))}
            </ul>
          )}
          {canValidate ? (
            <div className="mt-4 rounded-md border border-slate-300 bg-white p-4">
              <h3 className="mb-3 font-semibold">Créer une caisse</h3>
              <ActionForm
                action={createRegisterAction}
                idPrefix="register-"
                fields={[
                  { kind: 'select', name: 'siteId', label: 'Site', required: true, options: sites.map((s) => ({ value: s.id, label: s.city ? `${s.name} (${s.city})` : s.name })), placeholder: 'Choisir un site…' },
                  { kind: 'text', name: 'code', label: 'Code', required: true },
                  { kind: 'text', name: 'name', label: 'Nom', required: true },
                ]}
                submitLabel="Créer la caisse"
                pendingLabel="Création…"
              />
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}
