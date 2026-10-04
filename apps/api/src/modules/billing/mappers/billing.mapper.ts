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
} from '@ghmt/shared';
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
});

export const toInvoiceLineView = (row: PatientInvoiceLine): InvoiceLineView => ({
  id: row.id,
  lineNo: row.lineNo,
  priceListItemId: row.priceListItemId,
  category: row.category as ItemCategory,
  description: row.description,
  quantity: row.quantity.toString(),
  unitPrice: formatMoney(row.unitPrice),
  lineTotal: formatMoney(row.lineTotal),
});

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

export function toInvoiceDetail(row: InvoiceDetailRow, patient: InvoicePatientRef): InvoiceDetailView {
  return {
    ...toInvoiceSummary(row),
    subtotal: formatMoney(row.subtotal),
    notes: row.notes,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    // Identité administrative seulement : aucune donnée de contact sur une facture.
    patient: { id: patient.id, ipp: patient.ipp, fullName: formatPatientFullName(patient.firstName, patient.lastName) },
    lines: [...row.lines].sort((a, b) => a.lineNo - b.lineNo).map(toInvoiceLineView),
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
    validatedBy: row.validatedBy,
    validatedAt: row.validatedAt?.toISOString() ?? null,
  };
}
