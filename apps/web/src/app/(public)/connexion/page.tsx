import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { LoginForm } from '@/components/forms/LoginForm';
import { safeTenantSlug } from '@/lib/domain/security-forms';
import { safeNextPath } from '@/lib/forms';

export const metadata: Metadata = { title: 'Connexion' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ConnexionPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNextPath(one(params.next));
  const tenant = safeTenantSlug(one(params.etablissement)) ?? undefined;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Connexion</h1>
      {one(params.session) === 'expiree' ? <Alert tone="info">Votre session a expiré. Veuillez vous reconnecter.</Alert> : null}
      {one(params.inscrit) === '1' ? <Alert tone="success">Établissement créé. Connectez-vous avec le compte administrateur.</Alert> : null}
      {one(params.invitation) === 'acceptee' ? <Alert tone="success">Mot de passe défini. Connectez-vous avec le code de votre établissement.</Alert> : null}
      {one(params.reinitialise) === '1' ? <Alert tone="success">Mot de passe modifié. Connectez-vous avec votre nouveau mot de passe.</Alert> : null}
      {one(params.confirme) === '1' ? <Alert tone="success">Adresse e-mail confirmée : votre établissement est activé. Connectez-vous avec le compte administrateur.</Alert> : null}
      <LoginForm next={next} {...(tenant ? { defaultTenant: tenant } : {})} />
      <p className="text-sm text-slate-800">
        Nouvel établissement ? <Link href="/inscription" className="font-semibold text-blue-800 underline">Créer un compte</Link>
      </p>
    </div>
  );
}
