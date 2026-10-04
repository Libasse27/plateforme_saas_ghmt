import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { TotpEnrolment } from '@/components/forms/TotpEnrolment';
import { needsMfaStep } from '@/lib/auth/me';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Authentification à deux facteurs' };

export default async function MfaEnrolmentPage() {
  const me = await requireMe({ allowMfaPending: true });
  const alreadyActive = me.mfa.enrolled && me.mfa.verified;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Authentification à deux facteurs</h1>
      {needsMfaStep(me) ? (
        <Alert tone="warning">L&apos;authentification à deux facteurs est obligatoire pour votre compte. Activez-la pour accéder à la console.</Alert>
      ) : null}
      {alreadyActive ? (
        <>
          <Alert tone="success">L&apos;authentification à deux facteurs est déjà active sur votre compte.</Alert>
          <Link href="/" className="inline-block font-semibold text-blue-800 underline">Retour au tableau de bord</Link>
        </>
      ) : (
        <TotpEnrolment />
      )}
    </div>
  );
}
