import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/billing/PrintButton';
import { Receipt } from '@/components/billing/Receipt';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { settle } from '@/lib/api/settle';
import { canUse } from '@/lib/auth/me';
import { toReceipt } from '@/lib/domain/billing';
import { isUuid } from '@/lib/domain/raw';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Reçu de facture' };

export default async function ReceiptPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requireMe();
  if (!canUse(me, 'billing', 'billing:invoice:print')) return <AccessDenied what="l'impression des reçus" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await settle(() => pageApi(`/billing/invoices/${id}/receipt`));
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <Alert tone="error">{result.message}</Alert>;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <PrintButton label="Imprimer le reçu" />
        <Link href={`/facturation/factures/${encodeURIComponent(id)}`} className="text-blue-800 underline">Retour à la facture</Link>
      </div>
      <Receipt receipt={toReceipt(result.value.data)} timeZone={me.tenant.timezone} />
    </div>
  );
}
