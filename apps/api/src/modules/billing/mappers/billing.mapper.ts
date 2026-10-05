import type {
  CashRegisterView,
  CashSessionView,
  InvoiceDetailView,
  InvoiceLineView,
  InvoicePaymentView,
  InvoiceStatus,
  InvoiceSummaryView,
  ItemCategory,
  PriceListItemView,
  PriceListView,
  VoidReasonCode,
} from '@ghmt/shared';
import { NEUTRAL_CATEGORY_LABELS } from '@ghmt/shared';
import { formatMoney, zeroMoney } from '../../../common/money/money';
import type {
  CashRegister,
  CashSession,
  PatientInvoice,
  PatientInvoiceLine,
  PatientPayment,
  PriceList,
  PriceListItem,
} from '../../../generated/prisma/client';
import { formatPatientFullName } from '../../patients/domain/patient-identity';
import { balanceOf } from '../domain/invoice-status';

export type InvoiceDetailRow = PatientInvoice & { lines: PatientInvoiceLine[]; payments: PatientPayment[] };

export interface InvoicePatientRef {
  readonly id: string;
  readonly ipp: string;
  readonly firstName: string;
  readonly lastName: string;
}

/** Ce que le lecteur a le droit de voir d'une facture (docs/09 §R2-R3). */
export interface InvoiceViewPolicy {
  /** `consultations:consultation:read` : libellé réel des prestations sensibles (jamais sur le reçu). */
  readonly clinicalLabels: boolean;
  /** `patients:patient:read` : nom du patient. */
  readonly patientIdentity: boolean;
}

export const toPriceListView = (row: PriceList): PriceListView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  currency: row.currency,
  isDefault: row.isDefault,
  isActive: row.isActive,
});

export const toPriceListItemView = (row: PriceListItem): PriceListItemView => ({
  id: row.id,
  priceListId: row.priceListId,
  code: row.code,
  label: row.label,
  category: row.category as ItemCategory,
  unitPrice: formatMoney(row.unitPrice),
  isActive: row.isActive,
  isSensitive: row.isSensitive,
  printLabel: row.printLabel,
});

/** Libellé d'une ligne sensible hors clinique : libellé d'impression, à défaut libellé neutre de la catégorie. */
function maskedLabel(row: PatientInvoiceLine): string {
  return row.printLabel ?? NEUTRAL_CATEGORY_LABELS[row.category as ItemCategory] ?? NEUTRAL_CATEGORY_LABELS.autre;
}

export const toInvoiceLineView = (row: PatientInvoiceLine, clinicalLabels: boolean): InvoiceLineView => {
  const masked = row.isSensitive && !clinicalLabels;
  return {
    id: row.id,
    lineNo: row.lineNo,
    priceListItemId: row.priceListItemId,
    category: row.category as ItemCategory,
    description: masked ? maskedLabel(row) : row.description,
    isSensitive: row.isSensitive,
    labelMasked: masked,
    quantity: row.quantity.toString(),
  unitPrice: formatMoney(row.unitPrice),
  lineTotal: formatMoney(row.lineTotal),
  };
};

export const toPaymentView = (row: PatientPayment): InvoicePaymentView => ({
  id: row.id,
  method: row.method as InvoicePaymentView['method'],
  amount: formatMoney(row.amount),
  currency: row.currency,
  status: row.status as InvoicePaymentView['status'],
  paidAt: row.paidAt?.toISOString() ?? null,
  cashSessionId: row.cashSessionId,
  reference: row.reference,
  provider: row.provider,
  checkoutUrl: row.checkoutUrl,
  failureReason: row.failureReason,
  anomaly: row.anomaly,
  createdAt: row.createdAt.toISOString(),
});

export function toInvoiceSummary(row: PatientInvoice): InvoiceSummaryView {
  const balance = balanceOf(row.total, row.amountPaid);
  return {
    id: row.id,
    number: row.number,
    status: row.status as InvoiceStatus,
    patientId: row.patientId,
    siteId: row.siteId,
    appointmentId: row.appointmentId,
    currency: row.currency,
    total: formatMoney(row.total),
    amountPaid: formatMoney(row.amountPaid),
    // Un trop-perçu (anomalie signalée dans l'audit) ne produit jamais de reste dû négatif.
    balance: formatMoney(balance.isNegative() ? zeroMoney() : balance),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toInvoiceDetail(row: InvoiceDetailRow, patient: InvoicePatientRef, policy: InvoiceViewPolicy): InvoiceDetailView {
  return {
    ...toInvoiceSummary(row),
    subtotal: formatMoney(row.subtotal),
    notes: row.notes,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReasonCode: (row.voidReasonCode as VoidReasonCode | null) ?? null,
    // Sans commentaire, la colonne reprend le code du motif : seul un vrai commentaire est exposé.
    voidReason: row.voidReason !== null && row.voidReason !== row.voidReasonCode ? row.voidReason : null,
    // Identité administrative seulement (aucun contact) ; masquée sans `patients:patient:read`.
    patient: policy.patientIdentity
      ? { id: patient.id, ipp: patient.ipp, fullName: formatPatientFullName(patient.firstName, patient.lastName), identityMasked: false }
      : { id: patient.id, ipp: patient.ipp, fullName: null, identityMasked: true },
    lines: [...row.lines].sort((a, b) => a.lineNo - b.lineNo).map((line) => toInvoiceLineView(line, policy.clinicalLabels)),
    payments: [...row.payments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(toPaymentView),
  };
}

export const toCashRegisterView = (row: CashRegister): CashRegisterView => ({
  id: row.id,
  siteId: row.siteId,
  code: row.code,
  name: row.name,
  currency: row.currency,
  isActive: row.isActive,
});

/** `expectedTotal` d'une session ouverte est calculé à la volée (fond + espèces) ; une session clôturée porte la valeur figée. */
export function toCashSessionView(row: CashSession, liveExpectedTotal: string): CashSessionView {
  return {
    id: row.id,
    cashRegisterId: row.cashRegisterId,
    status: row.status as CashSessionView['status'],
    currency: row.currency,
    openedBy: row.openedBy,
    openedAt: row.openedAt.toISOString(),
    openingFloat: formatMoney(row.openingFloat),
    expectedTotal: row.expectedTotal ? formatMoney(row.expectedTotal) : liveExpectedTotal,
    closedBy: row.closedBy,
    closedAt: row.closedAt?.toISOString() ?? null,
    closingCounted: row.closingCounted ? formatMoney(row.closingCounted) : null,
    variance: row.variance ? formatMoney(row.variance) : null,
    forceClosed: row.forceClosed,
    validatedBy: row.validatedBy,
    validatedAt: row.validatedAt?.toISOString() ?? null,
  };
}
