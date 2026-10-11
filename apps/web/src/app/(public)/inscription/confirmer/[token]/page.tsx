import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { ConfirmSignupForm } from '@/components/forms/SignupVerificationForms';
import { describeApiError } from '@/lib/api/messages';
import { isOpaqueLinkToken } from '@/lib/domain/security-forms';

/** Le jeton figure dans l'URL de cette page : aucun en-tête Referer ne doit le divulguer. */
export const metadata: Metadata = { title: 'Confirmer mon adresse', referrer: 'no-referrer' };

/**
 * Aucun appel à l'API au chargement (docs/11 D1) : un scanner d'e-mails qui précharge le lien ne doit pas consommer
 * le jeton. La confirmation n'a lieu qu'au clic sur le bouton.
 */
export default async function ConfirmerInscriptionPage({ params }: { readonly params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Confirmer votre adresse e-mail</h1>
      {isOpaqueLinkToken(token) ? (
        <>
          <p className="text-slate-800">Confirmez l&apos;adresse e-mail de l&apos;administrateur pour activer votre établissement.</p>
          <ConfirmSignupForm token={token} />
        </>
      ) : (
        <>
          <Alert tone="error">{describeApiError({ status: 410, code: 'verification_token_invalid' })}</Alert>
          <Link href="/inscription/verifier" className="inline-block font-semibold text-blue-800 underline">Recevoir un nouveau lien</Link>
        </>
      )}
    </div>
  );
}
