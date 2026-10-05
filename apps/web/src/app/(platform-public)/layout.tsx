import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: { default: 'GHMT - Console plateforme', template: '%s | GHMT Plateforme' } };

export default function PlatformPublicLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-4">
      <p className="mb-4 text-center text-xl font-bold text-blue-900">GHMT Plateforme</p>
      <main className="rounded-lg border border-slate-300 bg-white p-6 shadow-sm">{children}</main>
    </div>
  );
}
