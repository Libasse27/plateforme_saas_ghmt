import { removeTrustedNetworkAction, addTrustedNetworkAction } from '@/actions/admin-security';
import { ActionForm } from '@/components/forms/ActionForm';
import { GuardedAction, TOTP_CODE_FIELD } from './GuardedAction';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { currentNetworkCidr } from '@/lib/domain/security-forms';
import type { TrustedNetworkView } from '@/lib/domain/security';
import { formatDateTime } from '@/lib/format/dates';

export interface TrustedNetworksPanelProps {
  readonly networks: readonly TrustedNetworkView[];
  /** Adresse vue par le serveur pour cette requête (jamais lue côté navigateur). */
  readonly requestIp: string | null;
  readonly requestIpTrusted: boolean;
  readonly canUpdate: boolean;
  readonly timeZone: string;
  /** Soignants actifs sans second facteur (docs/11 §14.1) : cités avant de retirer une plage. */
  readonly clinicalUsersWithoutMfa?: number;
}

const COLUMNS = [{ header: 'Plage' }, { header: 'Libellé' }, { header: 'Ajoutée' }, { header: 'Actions', hiddenHeader: true }] as const;
const DEFAULT_LABEL = 'Mon adresse actuelle';

/** « N soignants n'ont pas encore de second facteur » (accord au singulier compris) ; chaîne vide si aucun. */
export function clinicalWithoutMfaSentence(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 soignant n\'a pas encore de second facteur' : `${String(count)} soignants n'ont pas encore de second facteur`;
}

function NetworksTable({ networks, canUpdate, timeZone, clinicalUsersWithoutMfa = 0 }: Pick<TrustedNetworksPanelProps, 'networks' | 'canUpdate' | 'timeZone' | 'clinicalUsersWithoutMfa'>) {
  const exposed = clinicalWithoutMfaSentence(clinicalUsersWithoutMfa);
  return (
    <DataTable caption="Plages réseau de confiance de l'établissement" columns={COLUMNS}>
      {networks.map((network) => (
        <tr key={network.id}>
          <Cell><code className="font-mono">{network.cidr}</code></Cell>
          <Cell>{network.label}</Cell>
          <Cell>
            {network.createdAt ? formatDateTime(network.createdAt, timeZone) : 'Date inconnue'}
            {network.createdBy ? <span className="block text-slate-700">{network.createdBy.fullName}</span> : null}
          </Cell>
          <Cell>
            {canUpdate ? (
              <GuardedAction
                action={removeTrustedNetworkAction}
                hidden={{ networkId: network.id }}
                summary="Supprimer"
                confirmLabel="Confirmer la suppression"
                warning={`Retirer la plage ${network.cidr} ? Les soignants connectés depuis cette plage devront utiliser le second facteur.${exposed ? ` Attention : ${exposed} et seront bloqués jusqu'à son activation.` : ''}`}
                fields={[TOTP_CODE_FIELD]}
                idPrefix={`remove-${network.id}-`}
              />
            ) : null}
          </Cell>
        </tr>
      ))}
    </DataTable>
  );
}

function AddForms({ requestIp }: Pick<TrustedNetworksPanelProps, 'requestIp'>) {
  const current = currentNetworkCidr(requestIp);
  const suffix = current ? current.slice(current.lastIndexOf('/')) : '';
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {current ? (
        <section aria-labelledby="ajout-adresse" className="space-y-3 rounded-md border border-slate-300 bg-white p-4">
          <h3 id="ajout-adresse" className="font-semibold">Ajouter votre adresse actuelle</h3>
          <ActionForm
            action={addTrustedNetworkAction}
            idPrefix="current-"
            hidden={{ useCurrentIp: '1' }}
            fields={[{ kind: 'text', name: 'label', label: 'Libellé', required: true, defaultValue: DEFAULT_LABEL }, TOTP_CODE_FIELD]}
            submitLabel={`Ajouter ce réseau (${suffix})`}
            pendingLabel="Ajout…"
          />
        </section>
      ) : null}
      <section aria-labelledby="ajout-plage" className="space-y-3 rounded-md border border-slate-300 bg-white p-4">
        <h3 id="ajout-plage" className="font-semibold">Ajouter une plage</h3>
        <ActionForm
          action={addTrustedNetworkAction}
          idPrefix="add-"
          fields={[
            { kind: 'text', name: 'cidr', label: 'Plage réseau (CIDR)', hint: 'Par exemple 203.0.113.0/24. Adresses publiques seulement, au moins /24 en IPv4 et /48 en IPv6.', required: true },
            { kind: 'text', name: 'label', label: 'Libellé', required: true },
            TOTP_CODE_FIELD,
          ]}
          submitLabel="Ajouter la plage"
          pendingLabel="Ajout…"
        />
      </section>
    </div>
  );
}

/** Plages réseau de confiance (docs/11 D4) : adresse courante, liste, ajout, suppression confirmée. */
export function TrustedNetworksPanel({ networks, requestIp, requestIpTrusted, canUpdate, timeZone, clinicalUsersWithoutMfa = 0 }: TrustedNetworksPanelProps) {
  const address = requestIp
    ? `Votre adresse actuelle : ${requestIp} (réseau de confiance : ${requestIpTrusted ? 'oui' : 'non'}).`
    : 'Votre adresse actuelle n\'est pas connue du serveur.';
  return (
    <section aria-labelledby="reseaux" className="space-y-4">
      <h2 id="reseaux" className="text-lg font-semibold">Réseaux de confiance</h2>
      <p className="text-sm text-slate-800">
        Depuis ces plages, les soignants n&apos;ont pas à activer le second facteur (selon la politique choisie). Une plage vaut pour tout l&apos;établissement ; l&apos;adresse est vérifiée à chaque requête.
      </p>
      <p className="text-sm font-medium text-slate-900">{address}</p>
      <div role="note" aria-label="Attention aux adresses partagées ou instables" className="rounded-md border-l-4 border-amber-700 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Une adresse de box 4G ou d&apos;opérateur mobile (CGNAT), ou une adresse dynamique, est partagée avec d&apos;autres abonnés ou change sans prévenir :
        ne la déclarez pas comme réseau de confiance.
      </div>
      {networks.length === 0 ? (
        <p className="text-slate-700">Aucune plage déclarée : tous les réseaux sont hors confiance et le second facteur est exigé partout pour les soignants.</p>
      ) : (
        <NetworksTable networks={networks} canUpdate={canUpdate} timeZone={timeZone} clinicalUsersWithoutMfa={clinicalUsersWithoutMfa} />
      )}
      {canUpdate ? <AddForms requestIp={requestIp} /> : <p className="text-sm text-slate-700">Lecture seule : seul l&apos;administrateur principal peut modifier les réseaux de confiance.</p>}
    </section>
  );
}
