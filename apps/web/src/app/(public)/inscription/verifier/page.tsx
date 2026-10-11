import type { Metadata } from 'next';
import Link from 'next/link';
import { ResendVerificationForm } from '@/components/forms/SignupVerificationForms';
import { safeTenantSlug } from '@/lib/domain/security-forms';

export const metadata: Metadata = { title: 'Vérifiez votre boîte e-mail' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function VerifierInscriptionPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const raw = (await searchParams).etablissement;
  const tenant = safeTenantSlug(Array.isArray(raw) ? raw[0] : raw);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Vérifiez votre boîte e-mail</h1>
      <p className="text-slate-800">
        Votre établissement est créé mais pas encore actif. Cliquez sur le lien reçu par e-mail (valable 24 heures) pour confirmer l&apos;adresse de l&apos;administrateur.
        Sans confirmation sous 7 jours, l&apos;inscription est annulée.
      </p>
      <section aria-labelledby="renvoi" className="space-y-3 rounded-md border border-slate-300 p-4">
        <h2 id="renvoi" className="text-lg font-semibold">Vous n&apos;avez rien reçu ?</h2>
        <p className="text-sm text-slate-800">Vérifiez vos courriers indésirables, ou demandez un nouvel e-mail : seul le dernier lien reçu fonctionne.</p>
        <ResendVerificationForm {...(tenant ? { defaultTenant: tenant } : {})} />
      </section>
      <p className="text-sm text-slate-800">
        <Link href="/connexion" className="font-semibold text-blue-800 underline">Aller à la connexion</Link>
      </p>
    </div>
  );
}
