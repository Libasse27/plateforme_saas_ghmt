import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/forms/ForgotPasswordForm';
import { safeTenantSlug } from '@/lib/domain/security-forms';

export const metadata: Metadata = { title: 'Mot de passe oublié' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function MotDePasseOubliePage({ searchParams }: { readonly searchParams: SearchParams }) {
  const raw = (await searchParams).etablissement;
  const tenant = safeTenantSlug(Array.isArray(raw) ? raw[0] : raw);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Mot de passe oublié</h1>
      <p className="text-sm text-slate-800">
        Saisissez le code de votre établissement et votre adresse e-mail. Si un compte correspond, vous recevrez un lien pour choisir un nouveau mot de passe.
      </p>
      <ForgotPasswordForm {...(tenant ? { defaultTenant: tenant } : {})} />
    </div>
  );
}
