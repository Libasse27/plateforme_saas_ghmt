import type { ReactNode } from 'react';

/** Pages accessibles avec une session dont la MFA n'est pas encore vérifiée (pas de redirection vers /securite/mfa). */
export default function SecureLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-xl p-4">
      <p className="my-4 text-xl font-bold text-blue-900">GHMT</p>
      <main className="rounded-lg border border-slate-300 bg-white p-6 shadow-sm">{children}</main>
    </div>
  );
}
