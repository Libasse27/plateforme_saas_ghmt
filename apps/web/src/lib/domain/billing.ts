import {
  CASH_SESSION_STATUSES,
  INVOICE_STATUSES,
  ITEM_CATEGORIES,
  MAX_INVOICE_LINES,
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
  type RecordPaymentInput,
} from '@ghmt/shared';
import { lineTotal, parseMoneyInput, parseQuantityInput, sumAmounts } from './money';
import { normalizePhone } from './phone';
import { amount, bool, isUuid, items, num, rec, str, strOrNull } from './raw';

// ───────── Types propres au web (contrats R2, R3, R4, R5) ─────────
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentView extends Omit<InvoicePaymentView, 'status'> {
  readonly status: PaymentStatus;
  /** « overpaid » : paiement tardif supérieur au reste dû. */
  readonly anomaly: string | null;
}

export interface InvoiceLine extends InvoiceLineView {
  readonly isSensitive: boolean;
  readonly printLabel: string | null;
  /** Vrai : la description a été masquée par l'API pour ce lecteur. */
  readonly labelMasked: boolean;
}

export interface InvoicePatient {
  readonly id: string;
  readonly ipp: string;
  readonly fullName: string | null;
  readonly identityMasked: boolean;
}

export interface InvoiceDetail extends Omit<InvoiceDetailView, 'patient' | 'lines' | 'payments'> {
  readonly patient: InvoicePatient;
  readonly lines: readonly InvoiceLine[];
  readonly payments: readonly PaymentView[];
}

export interface ReceiptData {
  readonly establishment: string;
  readonly site: string;
  readonly invoice: InvoiceDetail;
  readonly printedAt: string;
  /** Facture annulée : filigrane « ANNULÉE ». */
  readonly voided: boolean;
}

export interface PriceItem extends PriceListItemView {
  readonly isSensitive: boolean;
  readonly printLabel: string | null;
  readonly labelMasked: boolean;
}

export const MEDICAL_INFO_WARNING = 'Ne saisissez aucune information médicale.';
export const MAX_VOID_COMMENT = 300;

export const VOID_REASON_LABELS = {
  duplicate: 'Doublon',
  wrong_price: 'Erreur de tarif',
  wrong_patient: 'Erreur de patient',
  service_not_rendered: 'Prestation non réalisée',
  other: 'Autre',
} as const;
export type VoidReasonCode = keyof typeof VOID_REASON_LABELS;
export const VOID_REASON_OPTIONS = Object.entries(VOID_REASON_LABELS).map(([value, label]) => ({ value, label }));

const NEUTRAL_LABELS: Readonly<Record<ItemCategory, string>> = {
  consultation: 'Consultation',
  acte: 'Acte médical',
  examen: 'Examen',
  medicament: 'Médicament',
  autre: 'Prestation',
};

/** Libellé affiché à l'écran : masqué par l'API pour un lecteur sans droit clinique. */
export function displayLabel(line: { readonly description: string; readonly category: ItemCategory; readonly labelMasked: boolean; readonly printLabel: string | null }): string {
  return line.labelMasked ? (line.printLabel ?? NEUTRAL_LABELS[line.category]) : line.description;
}

/** Libellé du reçu : exclusivement le libellé imprimable pour une ligne sensible. */
export function receiptLabel(line: { readonly description: string; readonly category: ItemCategory; readonly isSensitive: boolean; readonly labelMasked: boolean; readonly printLabel: string | null }): string {
  return line.isSensitive || line.labelMasked ? (line.printLabel ?? NEUTRAL_LABELS[line.category]) : line.description;
}

/** Identité affichée : « Patient {IPP} » sans nom quand l'identité est masquée (R3). */
export function patientDisplay(patient: InvoicePatient): string {
  if (patient.identityMasked || !patient.fullName) return patient.ipp ? `Patient ${patient.ipp}` : 'Patient';
  return patient.fullName;
}

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

export const PAYMENT_STATUS_LABELS: Readonly<Record<PaymentStatus, string>> = {
  pending: 'En attente',
  succeeded: 'Réussi',
  failed: 'Échoué',
  cancelled: 'Abandonné',
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

export function toPriceListItem(raw: unknown): PriceItem {
  const d = rec(raw);
  return {
    id: str(d.id),
    priceListId: str(d.priceListId),
    code: str(d.code),
    label: str(d.label),
    category: category(d.category),
    unitPrice: amount(d.unitPrice),
    isActive: bool(d.isActive),
    isSensitive: bool(d.isSensitive),
    printLabel: strOrNull(d.printLabel),
    labelMasked: bool(d.labelMasked),
  };
}

export function toInvoicePayment(raw: unknown): PaymentView {
  const d = rec(raw);
  return {
    id: str(d.id),
    method: oneOf(PAYMENT_METHODS, d.method, 'other'),
    amount: amount(d.amount),
    currency: str(d.currency, 'XOF'),
    status: oneOf(PAYMENT_STATUSES, d.status, 'pending'),
    anomaly: strOrNull(d.anomaly),
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

function toInvoiceLine(raw: unknown): InvoiceLine {
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
    isSensitive: bool(d.isSensitive),
    printLabel: strOrNull(d.printLabel),
    labelMasked: bool(d.labelMasked),
  };
}

export function toInvoiceDetail(raw: unknown): InvoiceDetail {
  const d = rec(raw);
  const patient = rec(d.patient);
  return {
    ...toInvoiceSummary(raw),
    subtotal: amount(d.subtotal),
    notes: strOrNull(d.notes),
    voidedAt: strOrNull(d.voidedAt),
    voidReasonCode: Object.hasOwn(VOID_REASON_LABELS, str(d.voidReasonCode)) ? (d.voidReasonCode as VoidReasonCode) : null,
    voidReason: strOrNull(d.voidReason),
    patient: {
      id: str(patient.id),
      ipp: str(patient.ipp),
      identityMasked: bool(patient.identityMasked),
      fullName: bool(patient.identityMasked) ? null : strOrNull(patient.fullName),
    },
    lines: items(d.lines, toInvoiceLine),
    payments: items(d.payments, toInvoicePayment),
  };
}

export function toOnlinePayment(raw: unknown): Omit<OnlinePaymentView, 'payment'> & { readonly payment: PaymentView } {
  const d = rec(raw);
  return { payment: toInvoicePayment(d.payment), checkoutUrl: strOrNull(d.checkoutUrl), instructions: strOrNull(d.instructions) };
}

export function toReceipt(raw: unknown): ReceiptData {
  const d = rec(raw);
  const invoice = toInvoiceDetail(d.invoice);
  return {
    establishment: str(d.establishment),
    site: str(d.site),
    invoice,
    printedAt: str(d.printedAt),
    voided: bool(d.voided) || invoice.status === 'void',
  };
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
    forceClosed: bool(d.forceClosed),
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
export function canVoid(invoice: Pick<InvoiceDetail, 'status' | 'payments'>): boolean {
  return invoice.status !== 'void' && invoice.payments.every((payment) => payment.status === 'failed' || payment.status === 'cancelled');
}

export function pendingOnlinePayments(invoice: Pick<InvoiceDetail, 'payments'>): PaymentView[] {
  return invoice.payments.filter((payment) => payment.status === 'pending' && (payment.method === 'mobile_money' || payment.method === 'card'));
}

// ───────── Saisie d'une facture ─────────
export type ParsedLines = { readonly ok: true; readonly lines: InvoiceLineInput[] } | { readonly ok: false; readonly error: string };

const LINES_ERROR = 'Ajoutez au moins une ligne valide à la facture.';

function parseLine(entry: unknown, allowFree: boolean, currency?: string): InvoiceLineInput | string {
  const d = rec(entry);
  const quantity = parseQuantityInput(str(d.quantity, '1'));
  if (!quantity.ok) return quantity.error;
  if (d.kind === 'catalog') {
    return isUuid(str(d.priceListItemId)) ? { priceListItemId: str(d.priceListItemId), quantity: quantity.quantity } : 'Article de la grille invalide.';
  }
  if (d.kind !== 'free') return LINES_ERROR;
  if (!allowFree) return 'Vous n\'avez pas le droit d\'ajouter une ligne libre : choisissez un article de la grille.';
  const unitPrice = parseMoneyInput(str(d.unitPrice), currency);
  if (!unitPrice.ok) return unitPrice.error;
  const description = str(d.description).trim();
  if (description.length < 2) return 'Le libellé d\'une ligne libre doit comporter au moins 2 caractères.';
  if (!(ITEM_CATEGORIES as readonly string[]).includes(str(d.category))) return 'Catégorie de ligne invalide.';
  return { description, category: d.category as ItemCategory, unitPrice: unitPrice.amount, quantity: quantity.quantity };
}

/** Lignes saisies dans l'interface (JSON d'un champ caché) vers le corps de POST /billing/invoices. */
export function parseDraftLines(raw: string | undefined, allowFree: boolean, currency?: string): ParsedLines {
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
    const line = parseLine(entry, allowFree, currency);
    if (typeof line === 'string') return { ok: false, error: line };
    lines.push(line);
  }
  return { ok: true, lines };
}

/** Total d'aperçu (le total officiel est recalculé par le serveur). */
export function invoiceTotals(lines: readonly { readonly unitPrice: string; readonly quantity: string }[], currency?: string): string {
  return sumAmounts(lines.map((line) => lineTotal(line.unitPrice, line.quantity, currency)));
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
  const money = parseMoneyInput(flat.amount ?? '', flat.currency);
  if (!money.ok) fieldErrors.amount = money.error;
  else if (!/[1-9]/.test(money.amount)) fieldErrors.amount = 'Le montant doit être strictement positif.';

  const body: Record<string, string> = { method, amount: money.ok ? money.amount : '' };
  if (method === 'cash' || method === 'other') {
    if (isUuid(flat.cashSessionId)) body.cashSessionId = flat.cashSessionId;
    else fieldErrors.cashSessionId = method === 'cash' ? 'Ouvrez une session de caisse avant d\'encaisser en espèces.' : 'Ouvrez une session de caisse avant d\'enregistrer ce paiement.';
  }
  if (method === 'mobile_money') {
    const phone = normalizePhone(flat.payerPhone ?? '', countryCode);
    if (phone.ok) body.payerPhone = phone.e164;
    else fieldErrors.payerPhone = phone.error;
  } else if (method === 'other') {
    const reference = (flat.reference ?? '').trim();
    if (reference.length === 0) fieldErrors.reference = 'Indiquez la référence du paiement (n° de chèque, de virement…).';
    else body.reference = reference.slice(0, 100);
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  const parsed = recordPaymentSchema.safeParse(body);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, fieldErrors: { amount: 'Paiement invalide. Vérifiez les informations saisies.' } };
}

// ───────── Annulation (R6) ─────────
export type VoidInputResult =
  | { readonly ok: true; readonly body: { readonly reasonCode: VoidReasonCode; readonly comment?: string } }
  | { readonly ok: false; readonly fieldErrors: Record<string, string> };

/** Motif codifié obligatoire, commentaire facultatif (300 caractères au plus, sans information médicale). */
export function buildVoidInput(flat: Readonly<Record<string, string | undefined>>): VoidInputResult {
  const code = flat.reasonCode;
  if (!code || !Object.hasOwn(VOID_REASON_LABELS, code)) return { ok: false, fieldErrors: { reasonCode: 'Choisissez le motif de l\'annulation.' } };
  const comment = (flat.comment ?? '').trim();
  if (comment.length > MAX_VOID_COMMENT) return { ok: false, fieldErrors: { comment: `Le commentaire ne peut pas dépasser ${String(MAX_VOID_COMMENT)} caractères.` } };
  return { ok: true, body: comment ? { reasonCode: code as VoidReasonCode, comment } : { reasonCode: code as VoidReasonCode } };
}
