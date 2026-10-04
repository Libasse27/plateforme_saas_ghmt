'use client';

import { buttonClass } from '@/components/ui/styles';

export default function GlobalError({ reset }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-2xl font-bold">Une erreur est survenue</h1>
      <p className="mt-2 text-slate-800">Le service est momentanément indisponible. Vérifiez votre connexion puis réessayez.</p>
      <button type="button" onClick={reset} className={`${buttonClass.primary} mt-4`}>Réessayer</button>
    </main>
  );
}
