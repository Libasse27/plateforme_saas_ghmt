import type { Metadata } from 'next';
import Link from 'next/link';
import { InvoiceComposer } from '@/components/billing/InvoiceComposer';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { settle } from '@/lib/api/settle';
import { canUse } from '@/lib/auth/me';
import { displayLabel, toPriceList, toPriceListItem } from '@/lib/domain/billing';
import { toPatient, toList, toSite } from '@/lib/domain/mappers';
import { isUuid, items } from '@/lib/domain/raw';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Nouvelle facture' };

const CATALOG_LIMIT = 100;

export default async function NewInvoicePage({ searchParams }: { readonly searchParams: Promise<{ patientId?: string; appointmentId?: string }> }) {
  const me = await requireMe();
  if (!canUse(me, 'billing', 'billing:invoice:create')) return <AccessDenied what="la création de factures" />;
  const params = await searchParams;
  const patientId = isUuid(params.patientId) ? params.patientId : undefined;
  const appointmentId = isUuid(params.appointmentId) ? params.appointmentId : undefined;
  const canSearchPatients = canUse(me, 'patients', 'patients:patient:read');
  const canReadPrices = canUse(me, 'billing', 'billing:price_list:read');

  const [sitesResult, listsResult, patientResult] = await Promise.all([
    settle(() => pageApi('/org/sites')),
    canReadPrices ? settle(() => pageApi('/billing/price-lists')) : Promise.resolve(null),
    patientId && canSearchPatients ? settle(() => pageApi(`/patients/${patientId}`)) : Promise.resolve(null),
  ]);
  if (!sitesResult.ok) return <Alert tone="error">{sitesResult.message}</Alert>;

  const lists = listsResult?.ok ? items(listsResult.value.data, toPriceList) : [];
  const priceList = lists.find((l) => l.isDefault && l.isActive) ?? lists.find((l) => l.isActive);
  const catalogResult = priceList ? await settle(() => pageApi(`/billing/price-lists/${priceList.id}/items`, { query: { limit: CATALOG_LIMIT } })) : null;
  const catalog = catalogResult?.ok ? items(catalogResult.value.data, toPriceListItem).filter((item) => item.isActive) : [];
  const patient = patientResult?.ok ? toPatient(patientResult.value.data) : null;
  const allowFreeLines = canUse(me, 'billing', 'billing:invoice:update');

  if (!canSearchPatients && !patientId) return <AccessDenied what="la recherche de patients" />;

  return (
    <>
      <PageHeader title="Nouvelle facture" description="Choisissez le patient, ajoutez les actes puis émettez la facture." />
      {patientResult && !patientResult.ok ? <Alert tone="error">{patientResult.message}</Alert> : null}
      <InvoiceComposer
        sites={toList(sitesResult.value.data, toSite).map((s) => ({ value: s.id, label: s.city ? `${s.name} (${s.city})` : s.name }))}
        catalog={catalog.map((item) => ({ id: item.id, label: displayLabel({ description: item.label, category: item.category, labelMasked: item.labelMasked, printLabel: item.printLabel }), unitPrice: item.unitPrice }))}
        currency={priceList?.currency ?? (me.tenant.baseCurrency || 'XOF')}
        allowFreeLines={allowFreeLines}
        initialPatient={patient && patient.id ? { id: patient.id, fullName: patient.fullName } : patientId ? { id: patientId, fullName: 'Patient sélectionné' } : undefined}
        appointmentId={appointmentId}
      />
      <p className="mt-6"><Link href="/facturation/factures" className="text-blue-800 underline">Retour aux factures</Link></p>
    </>
  );
}
