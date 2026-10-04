import {
  CASH_SESSION_STATUSES,
  INVOICE_STATUSES,
  ITEM_CATEGORIES,
  MAX_INVOICE_LINES,
  PATIENT_PAYMENT_STATUSES,
  PAYMENT_METHODS,
  recordPaymentSchema,
  type CashRegisterView,
  type CashSessionStatus,
  type CashSessionView,
  type InvoiceDetailView,
  type InvoiceLineInput,
  type InvoiceLineView,
  type InvoicePaymentView,
  type InvoiceStatus,
  type InvoiceSummaryView,
  type ItemCategory,
  type OnlinePaymentView,
  type PaymentMethod,
  type PriceListItemView,
  type PriceListView,
  type ReceiptView,
  type RecordPaymentInput,
} from '@ghmt/shared';
import { lineTotal, parseMoneyInput, parseQuantityInput, sumAmounts } from './money';
import { normalizePhone } from './phone';
import { amount, bool, isUuid, items, num, rec, str, strOrNull } from './raw';

export const INVOICE_STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
  draft: 'Brouillon',
  issued: 'Émise',
  partially_paid: 'Partiellement payée',
  paid: 'Payée',
  void: 'Annulée',
};

export const CATEGORY_LABELS: Readonly<Record<ItemCategory, string>> = {
  consultation: 'Consultation',
  acte: 'Acte',
  examen: 'Examen',
  medicament: 'Médicament',
  autre: 'Autre',
};

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  cash: 'Espèces',
  mobile_money: 'Mobile Money',
  card: 'Carte',
  other: 'Autre mode',
};

export const PAYMENT_STATUS_LABELS: Readonly<Record<InvoicePaymentView['status'], string>> = {
  pending: 'En attente',
  succeeded: 'Réussi',
  failed: 'Échoué',
};

export const CASH_SESSION_STATUS_LABELS: Readonly<Record<CashSessionStatus, string>> = {
  open: 'Ouverte',
  closed: 'Clôturée (à valider)',
  validated: 'Validée',
};

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const category = (value: unknown): ItemCategory => oneOf(ITEM_CATEGORIES, value, 'autre');

export function toPriceList(raw: unknown): PriceListView {
  const d = rec(raw);
  return { id: str(d.id), code: str(d.code), name: str(d.name), currency: str(d.currency, 'XOF'), isDefault: bool(d.isDefault), isActive: bool(d.isActive) };
}

export function toPriceListItem(raw: unknown): PriceListItemView {
  const d = rec(raw);
  return {
    id: str(d.id),
    priceListId: str(d.priceListId),
    code: str(d.code),
    label: str(d.label),
    category: category(d.category),
    unitPrice: amount(d.unitPrice),
    isActive: bool(d.isActive),
  };
}

export function toInvoicePayment(raw: unknown): InvoicePaymentView {
  const d = rec(raw);
  return {
    id: str(d.id),
    method: oneOf(PAYMENT_METHODS, d.method, 'other'),
    amount: amount(d.amount),
    currency: str(d.currency, 'XOF'),
    status: oneOf(PATIENT_PAYMENT_STATUSES, d.status, 'pending'),
    paidAt: strOrNull(d.paidAt),
    cashSessionId: strOrNull(d.cashSessionId),
    reference: strOrNull(d.reference),
    provider: strOrNull(d.provider),
    checkoutUrl: strOrNull(d.checkoutUrl),
    failureReason: strOrNull(d.failureReason),
    createdAt: str(d.createdAt),
  };
}

export function toInvoiceSummary(raw: unknown): InvoiceSummaryView {
  const d = rec(raw);
  return {
    id: str(d.id),
    number: strOrNull(d.number),
    status: oneOf(INVOICE_STATUSES, d.status, 'draft'),
    patientId: str(d.patientId),
    siteId: str(d.siteId),
    appointmentId: strOrNull(d.appointmentId),
    currency: str(d.currency, 'XOF'),
    total: amount(d.total),
    amountPaid: amount(d.amountPaid),
    balance: amount(d.balance),
    issuedAt: strOrNull(d.issuedAt),
    createdAt: str(d.createdAt),
  };
}

function toInvoiceLine(raw: unknown): InvoiceLineView {
  const d = rec(raw);
  return {
    id: str(d.id),
    lineNo: num(d.lineNo),
    priceListItemId: strOrNull(d.priceListItemId),
    category: category(d.category),
    description: str(d.description),
    quantity: str(d.quantity, '1'),
    unitPrice: amount(d.unitPrice),
    lineTotal: amount(d.lineTotal),
  };
}

export function toInvoiceDetail(raw: unknown): InvoiceDetailView {
  const d = rec(raw);
  const patient = rec(d.patient);
  return {
    ...toInvoiceSummary(raw),
    subtotal: amount(d.subtotal),
    notes: strOrNull(d.notes),
    voidedAt: strOrNull(d.voidedAt),
    voidReason: strOrNull(d.voidReason),
    patient: { id: str(patient.id), ipp: str(patient.ipp), fullName: str(patient.fullName, 'Patient') },
    lines: items(d.lines, toInvoiceLine),
    payments: items(d.payments, toInvoicePayment),
  };
}

export function toOnlinePayment(raw: unknown): OnlinePaymentView {
  const d = rec(raw);
  return { payment: toInvoicePayment(d.payment), checkoutUrl: strOrNull(d.checkoutUrl), instructions: strOrNull(d.instructions) };
}

export function toReceipt(raw: unknown): ReceiptView {
  const d = rec(raw);
  return { establishment: str(d.establishment), site: str(d.site), invoice: toInvoiceDetail(d.invoice), printedAt: str(d.printedAt) };
}

export function toCashRegister(raw: unknown): CashRegisterView {
  const d = rec(raw);
  return { id: str(d.id), siteId: str(d.siteId), code: str(d.code), name: str(d.name), currency: str(d.currency, 'XOF'), isActive: bool(d.isActive) };
}

export function toCashSession(raw: unknown): CashSessionView {
  const d = rec(raw);
  return {
    id: str(d.id),
    cashRegisterId: str(d.cashRegisterId),
    status: oneOf(CASH_SESSION_STATUSES, d.status, 'open'),
    currency: str(d.currency, 'XOF'),
    openedBy: str(d.openedBy),
    openedAt: str(d.openedAt),
    openingFloat: amount(d.openingFloat),
    expectedTotal: amount(d.expectedTotal),
    closedBy: strOrNull(d.closedBy),
    closedAt: strOrNull(d.closedAt),
    closingCounted: typeof d.closingCounted === 'string' ? amount(d.closingCounted) : null,
    variance: typeof d.variance === 'string' ? amount(d.variance) : null,
    validatedBy: strOrNull(d.validatedBy),
    validatedAt: strOrNull(d.validatedAt),
  };
}

// ───────── Règles d'affichage ─────────
const POSITIVE_BALANCE = /[1-9]/;

export function isPayable(invoice: Pick<InvoiceSummaryView, 'status' | 'balance'>): boolean {
  return (invoice.status === 'issued' || invoice.status === 'partially_paid') && POSITIVE_BALANCE.test(invoice.balance);
}

export function canIssue(invoice: Pick<InvoiceSummaryView, 'status'>): boolean {
  return invoice.status === 'draft';
}

/** Annulation possible seulement sans encaissement réussi ni en attente (l'API reste l'autorité). */
export function canVoid(invoice: Pick<InvoiceDetailView, 'status' | 'payments'>): boolean {
  return invoice.status !== 'void' && invoice.payments.every((payment) => payment.status === 'failed');
}

export function pendingOnlinePayments(invoice: Pick<InvoiceDetailView, 'payments'>): InvoicePaymentView[] {
  return invoice.payments.filter((payment) => payment.status === 'pending' && (payment.method === 'mobile_money' || payment.method === 'card'));
}

// ───────── Saisie d'une facture ─────────
export type ParsedLines = { readonly ok: true; readonly lines: InvoiceLineInput[] } | { readonly ok: false; readonly error: string };

const LINES_ERROR = 'Ajoutez au moins une ligne valide à la facture.';

function parseLine(entry: unknown, allowFree: boolean): InvoiceLineInput | string {
  const d = rec(entry);
  const quantity = parseQuantityInput(str(d.quantity, '1'));
  if (!quantity.ok) return quantity.error;
  if (d.kind === 'catalog') {
    return isUuid(str(d.priceListItemId)) ? { priceListItemId: str(d.priceListItemId), quantity: quantity.quantity } : 'Article de la grille invalide.';
  }
  if (d.kind !== 'free') return LINES_ERROR;
  if (!allowFree) return 'Vous n\'avez pas le droit d\'ajouter une ligne libre : choisissez un article de la grille.';
  const unitPrice = parseMoneyInput(str(d.unitPrice));
  if (!unitPrice.ok) return unitPrice.error;
  const description = str(d.description).trim();
  if (description.length < 2) return 'Le libellé d\'une ligne libre doit comporter au moins 2 caractères.';
  if (!(ITEM_CATEGORIES as readonly string[]).includes(str(d.category))) return 'Catégorie de ligne invalide.';
  return { description, category: d.category as ItemCategory, unitPrice: unitPrice.amount, quantity: quantity.quantity };
}

/** Lignes saisies dans l'interface (JSON d'un champ caché) vers le corps de POST /billing/invoices. */
export function parseDraftLines(raw: string | undefined, allowFree: boolean): ParsedLines {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '[]');
  } catch {
    return { ok: false, error: LINES_ERROR };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, error: LINES_ERROR };
  if (parsed.length > MAX_INVOICE_LINES) return { ok: false, error: `Une facture ne peut pas dépasser ${String(MAX_INVOICE_LINES)} lignes.` };
  const lines: InvoiceLineInput[] = [];
  for (const entry of parsed) {
    const line = parseLine(entry, allowFree);
    if (typeof line === 'string') return { ok: false, error: line };
    lines.push(line);
  }
  return { ok: true, lines };
}

/** Total d'aperçu (le total officiel est recalculé par le serveur). */
export function invoiceTotals(lines: readonly { readonly unitPrice: string; readonly quantity: string }[]): string {
  return sumAmounts(lines.map((line) => lineTotal(line.unitPrice, line.quantity)));
}

// ───────── Encaissement ─────────
export type PaymentInputResult =
  | { readonly ok: true; readonly body: RecordPaymentInput }
  | { readonly ok: false; readonly fieldErrors: Record<string, string> };

/** Formulaire d'encaissement vers le corps de POST /billing/invoices/:id/payments (téléphone normalisé en E.164). */
export function buildPaymentInput(flat: Readonly<Record<string, string | undefined>>, countryCode: string): PaymentInputResult {
  const fieldErrors: Record<string, string> = {};
  const method = flat.method;
  if (method !== 'cash' && method !== 'mobile_money' && method !== 'other') {
    return { ok: false, fieldErrors: { method: 'Choisissez un mode de paiement.' } };
  }
  const money = parseMoneyInput(flat.amount ?? '');
  if (!money.ok) fieldErrors.amount = money.error;
  else if (!/[1-9]/.test(money.amount)) fieldErrors.amount = 'Le montant doit être strictement positif.';

  const body: Record<string, string> = { method, amount: money.ok ? money.amount : '' };
  if (method === 'cash') {
    if (isUuid(flat.cashSessionId)) body.cashSessionId = flat.cashSessionId;
    else fieldErrors.cashSessionId = 'Ouvrez une session de caisse avant d\'encaisser en espèces.';
  } else if (method === 'mobile_money') {
    const phone = normalizePhone(flat.payerPhone ?? '', countryCode);
    if (phone.ok) body.payerPhone = phone.e164;
    else fieldErrors.payerPhone = phone.error;
  } else {
    const reference = (flat.reference ?? '').trim();
    if (reference.length === 0) fieldErrors.reference = 'Indiquez la référence du paiement (n° de chèque, de virement…).';
    else body.reference = reference.slice(0, 100);
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  const parsed = recordPaymentSchema.safeParse(body);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, fieldErrors: { amount: 'Paiement invalide. Vérifiez les informations saisies.' } };
}
