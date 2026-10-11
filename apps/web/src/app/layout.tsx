import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'GHMT - Console établissement', template: '%s | GHMT' },
  description: 'Console de gestion des établissements de santé GHMT.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/**
 * Rendu dynamique obligatoire (docs/11 D14) : le nonce de la CSP est propre à chaque requête, et Next ne peut
 * l'appliquer qu'au rendu serveur d'une requête réelle (jamais à une page prérendue au build).
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  await connection();
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
