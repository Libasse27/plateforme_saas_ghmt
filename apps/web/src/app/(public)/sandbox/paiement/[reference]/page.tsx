import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SandboxPayment } from '@/components/billing/SandboxPayment';
import { safeNextPath } from '@/lib/forms';

export const metadata: Metadata = { title: 'Paiement simulé', robots: { index: false, follow: false } };

const PROVIDER_REFERENCE = /^[A-Za-z0-9_-]{8,100}$/;

/** Page de développement : 404 en production et pour toute référence mal formée. */
export default async function SandboxPaymentPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ reference: string }>;
  readonly searchParams: Promise<{ retour?: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { reference } = await params;
  if (!PROVIDER_REFERENCE.test(reference)) notFound();
  const { retour } = await searchParams;
  return <SandboxPayment reference={reference} returnTo={safeNextPath(retour)} />;
}
