import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { InvitationForm } from '@/components/forms/InvitationForm';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { isInvitationToken } from '@/lib/schemas';
import { publicRequest } from '@/server/api';

export const metadata: Metadata = { title: 'Invitation', referrer: 'no-referrer' };

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function loadInvitation(token: string): Promise<{ email: string; fullName: string; tenantName: string } | { error: string }> {
  try {
    const { data } = await publicRequest(`/auth/invitations/${encodeURIComponent(token)}`);
    const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    return { email: text(record.email), fullName: text(record.fullName), tenantName: text(record.tenantName) };
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { error: error.status === 404 ? describeApiError({ status: 410, code: 'invitation_expired' }) : describeApiError(error) };
  }
}

export default async function InvitationPage({ params }: { readonly params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = isInvitationToken(token) ? await loadInvitation(token) : { error: describeApiError({ status: 410, code: 'invitation_expired' }) };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Activer votre compte</h1>
      {'error' in invitation ? (
        <>
          <Alert tone="error">{invitation.error}</Alert>
          <Link href="/connexion" className="inline-block font-semibold text-blue-800 underline">Aller à la connexion</Link>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-800">
            {invitation.fullName ? <strong>{invitation.fullName}</strong> : 'Vous'}
            {invitation.tenantName ? <> êtes invité(e) à rejoindre <strong>{invitation.tenantName}</strong>.</> : ' êtes invité(e).'}
            {invitation.email ? <> Compte : {invitation.email}.</> : null} Choisissez votre mot de passe.
          </p>
          <InvitationForm token={token} />
        </>
      )}
    </div>
  );
}
