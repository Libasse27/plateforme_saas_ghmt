import type { Metadata } from 'next';
import Link from 'next/link';
import { activatePlatformTotpAction, platformLogoutAction, startPlatformTotpSetupAction } from '@/actions/platform-auth';
import { TotpEnrolment } from '@/components/forms/TotpEnrolment';
import { Alert } from '@/components/ui/Alert';
import { buttonClass } from '@/components/ui/styles';
import { PLATFORM_HOME_PATH } from '@/lib/auth/platform-me';
import { getPlatformMe } from '@/server/platform-me';

export const metadata: Metadata = { title: 'Authentification à deux facteurs' };

export default async function PlatformMfaEnrolmentPage() {
  const me = await getPlatformMe();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Authentification à deux facteurs</h1>
      {me.mfaVerified ? (
        <>
          <Alert tone="success">L&apos;authentification à deux facteurs est active sur votre compte.</Alert>
          <Link href={PLATFORM_HOME_PATH} className="inline-block font-semibold text-blue-800 underline">Retour au tableau de bord</Link>
        </>
      ) : me.mfaEnrolled ? (
        <>
          <Alert tone="warning">Votre compte est déjà enrôlé mais cette session n&apos;est pas vérifiée. Déconnectez-vous puis reconnectez-vous pour saisir votre code.</Alert>
          <form action={platformLogoutAction}>
            <button type="submit" className={buttonClass.primary}>Se déconnecter</button>
          </form>
        </>
      ) : (
        <>
          <Alert tone="warning">L&apos;authentification à deux facteurs est obligatoire pour les administrateurs plateforme. Activez-la pour accéder à la console.</Alert>
          <TotpEnrolment startSetup={startPlatformTotpSetupAction} activate={activatePlatformTotpAction} continueHref={PLATFORM_HOME_PATH} />
        </>
      )}
    </div>
  );
}
