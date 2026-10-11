import type { Metadata } from 'next';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { OwnerTransferForm } from '@/components/security/OwnerTransferForm';
import { SecurityPolicyForm } from '@/components/security/SecurityPolicyForm';
import { TrustedNetworksPanel } from '@/components/security/TrustedNetworksPanel';
import { settle } from '@/lib/api/settle';
import { hasPermission } from '@/lib/auth/me';
import { toSecurityPolicy, isOwnerOf } from '@/lib/domain/security';
import { toUserSummary } from '@/lib/domain/admin';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';
import { loadOptional } from '../_lib/page-data';

export const metadata: Metadata = { title: 'Sécurité de l\'établissement' };

const CANDIDATES_LIMIT = 100;

export default async function SecurityPage() {
  const me = await requireMe();
  if (!hasPermission(me, 'iam:policy:read')) return <AccessDenied what="les réglages de sécurité de l'établissement" />;

  const loaded = await settle(() => pageApi('/iam/security/policy'));
  if (!loaded.ok) return <Alert tone="error">{loaded.message}</Alert>;
  const policy = toSecurityPolicy(loaded.value.data);
  const canUpdate = hasPermission(me, 'iam:policy:update');
  const viewerIsOwner = isOwnerOf(policy, me.user.id);

  const users = await loadOptional(viewerIsOwner && canUpdate && hasPermission(me, 'iam:user:read'), '/iam/users', toUserSummary, {
    status: 'active',
    limit: CANDIDATES_LIMIT,
  });
  const candidates = users.filter((user) => user.id !== me.user.id && user.status === 'active');

  return (
    <>
      <PageHeader title="Sécurité" description="Second facteur des soignants, réseaux de confiance et administrateur principal de l'établissement." />
      <div className="space-y-10">
        <SecurityPolicyForm policy={policy} canUpdate={canUpdate} />
        <TrustedNetworksPanel
          networks={policy.trustedNetworks}
          requestIp={policy.requestIp}
          requestIpTrusted={policy.requestIpTrusted}
          canUpdate={canUpdate}
          timeZone={me.tenant.timezone}
          clinicalUsersWithoutMfa={policy.clinicalUsersWithoutMfa}
        />
        <section aria-labelledby="principal" className="space-y-3">
          <h2 id="principal" className="text-lg font-semibold">Administrateur principal</h2>
          <p className="text-sm font-medium text-slate-900">{`Administrateur principal : ${policy.owner?.fullName ?? 'non désigné'}.`}</p>
          <p className="text-sm text-slate-700">
            Seul l&apos;administrateur principal peut agir sur les autres administrateurs et accorder un rôle d&apos;administration. Il ne peut pas se désactiver sans avoir transféré le titre.
          </p>
          {viewerIsOwner && canUpdate ? <OwnerTransferForm candidates={candidates} /> : null}
        </section>
      </div>
    </>
  );
}
