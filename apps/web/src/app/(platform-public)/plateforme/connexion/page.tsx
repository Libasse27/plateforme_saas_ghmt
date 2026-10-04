import type { Metadata } from 'next';
import { Alert } from '@/components/ui/Alert';
import { PlatformLoginForm } from '@/components/forms/PlatformLoginForm';
import { safePlatformPath } from '@/lib/forms';

export const metadata: Metadata = { title: 'Connexion' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PlatformLoginPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const params = await searchParams;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Connexion à la console plateforme</h1>
      {one(params.session) === 'expiree' ? <Alert tone="info">Votre session a expiré. Veuillez vous reconnecter.</Alert> : null}
      <p className="text-sm text-slate-800">Accès réservé aux administrateurs GHMT. Une vérification en deux étapes est obligatoire.</p>
      <PlatformLoginForm next={safePlatformPath(one(params.next))} />
    </div>
  );
}
