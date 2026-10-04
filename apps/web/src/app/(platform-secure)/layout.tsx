import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: { default: 'GHMT - Console plateforme', template: '%s | GHMT Plateforme' } };

/** Pages accessibles avec une session plateforme dont la MFA n'est pas encore vérifiée. */
export default function PlatformSecureLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-xl p-4">
      <p className="my-4 text-xl font-bold text-blue-900">GHMT Plateforme</p>
      <main className="rounded-lg border border-slate-300 bg-white p-6 shadow-sm">{children}</main>
    </div>
  );
}
