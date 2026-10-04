import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { MfaVerifyForm } from '@/components/forms/MfaVerifyForm';
import { safeNextPath } from '@/lib/forms';
import { readMfaChallenge } from '@/lib/session/store';

export const metadata: Metadata = { title: 'Vérification en deux étapes' };

export default async function MfaChallengePage({ searchParams }: { readonly searchParams: Promise<{ next?: string }> }) {
  if (!(await readMfaChallenge())) redirect('/connexion?session=expiree');
  const { next } = await searchParams;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Vérification en deux étapes</h1>
      <MfaVerifyForm next={safeNextPath(next)} />
    </div>
  );
}
