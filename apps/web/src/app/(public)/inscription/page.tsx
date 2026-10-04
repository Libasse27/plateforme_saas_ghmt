import type { Metadata } from 'next';
import Link from 'next/link';
import { SignupWizard } from '@/components/forms/SignupWizard';

export const metadata: Metadata = { title: 'Inscription d\'un établissement' };

export default function InscriptionPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Inscrire votre établissement</h1>
      <SignupWizard />
      <p className="text-sm text-slate-800">
        Déjà inscrit ? <Link href="/connexion" className="font-semibold text-blue-800 underline">Se connecter</Link>
      </p>
    </div>
  );
}
