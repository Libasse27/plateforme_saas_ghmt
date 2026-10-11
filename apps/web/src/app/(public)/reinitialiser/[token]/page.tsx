import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { ResetPasswordForm } from '@/components/forms/ResetPasswordForm';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { rec, str, bool } from '@/lib/domain/raw';
import { isOpaqueLinkToken, safeTenantSlug } from '@/lib/domain/security-forms';
import { publicRequest } from '@/server/api';

/** Le jeton figure dans l'URL de cette page : aucun en-tête Referer ne doit le divulguer. */
export const metadata: Metadata = { title: 'Nouveau mot de passe', referrer: 'no-referrer' };

interface Preview {
  readonly tenantSlug: string;
  readonly emailMasked: string;
  readonly mfaRequired: boolean;
}

type Loaded = { readonly preview: Preview } | { readonly error: string; readonly invalidLink: boolean };

const INVALID_LINK = describeApiError({ status: 410, code: 'reset_token_invalid' });
const UNEXPECTED = 'Réponse inattendue du serveur. Veuillez réessayer.';

/** L'aperçu ne consomme pas le jeton : seule la validation du formulaire (mot de passe saisi) le fait. */
async function loadPreview(token: string): Promise<Loaded> {
  if (!isOpaqueLinkToken(token)) return { error: INVALID_LINK, invalidLink: true };
  try {
    const data = rec((await publicRequest('/auth/password/reset/preview', { method: 'POST', body: { token } })).data);
    const tenantSlug = safeTenantSlug(str(data.tenantSlug));
    const emailMasked = str(data.emailMasked);
    if (!tenantSlug || !emailMasked) return { error: UNEXPECTED, invalidLink: false };
    return { preview: { tenantSlug, emailMasked, mfaRequired: bool(data.mfaRequired) } };
  } catch (error) {
    if (!isApiError(error)) throw error;
    const invalidLink = error.status === 410 || error.status === 404;
    return { error: invalidLink ? INVALID_LINK : describeApiError(error), invalidLink };
  }
}

export default async function ReinitialiserPage({ params }: { readonly params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await loadPreview(token);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Nouveau mot de passe</h1>
      {'error' in loaded ? (
        <>
          <Alert tone="error">{loaded.error}</Alert>
          <Link href="/mot-de-passe-oublie" className="inline-block font-semibold text-blue-800 underline">
            {loaded.invalidLink ? 'Demander un nouveau lien' : 'Revenir à la demande de lien'}
          </Link>
        </>
      ) : (
        <ResetPasswordForm token={token} {...loaded.preview} />
      )}
    </div>
  );
}
