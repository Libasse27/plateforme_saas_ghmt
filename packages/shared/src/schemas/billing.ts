/**
 * Schémas Zod propres au module billing (facturation patient, caisse).
 * Chaque équipe de module n'édite que son propre fichier ; les schémas communs restent dans ./index.ts.
 */
import { z } from 'zod';
import { currencyCode, moneyAmount, positiveMoneyAmount } from './payments';
import { phoneE164, uuid } from './primitives';

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const ITEM_CATEGORIES = ['consultation', 'acte', 'examen', 'medicament', 'autre'] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];
export const PAYMENT_METHODS = ['cash', 'mobile_money', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PATIENT_PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled'] as const;
export const CASH_SESSION_STATUSES = ['open', 'closed', 'validated'] as const;
export type CashSessionStatus = (typeof CASH_SESSION_STATUSES)[number];

export const MAX_INVOICE_LINES = 100;
const REASON_MIN = 3;
const VOID_COMMENT_MAX = 300;

/** Motifs d'annulation d'une facture (seul le code figure dans l'audit). */
export const VOID_REASON_CODES = ['duplicate', 'wrong_price', 'wrong_patient', 'service_not_rendered', 'other'] as const;
export type VoidReasonCode = (typeof VOID_REASON_CODES)[number];

/** Libellés neutres des lignes sensibles sans libellé d'impression, par catégorie (docs/09 §R2). */
export const NEUTRAL_CATEGORY_LABELS: Readonly<Record<'consultation' | 'acte' | 'examen' | 'medicament' | 'autre', string>> = {
  consultation: 'Consultation',
  acte: 'Acte médical',
  examen: 'Examen',
  medicament: 'Médicament',
  autre: 'Prestation',
};

const code = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'code : lettres, chiffres, point, tiret, souligné');
const label = z.string().trim().min(2).max(200);
const printLabel = z.string().trim().min(2).max(200);
const note = z.string().trim().min(1).max(500);
/** Quantité décimale en chaîne (3 décimales au plus), strictement positive. */
const quantity = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'quantité décimale en chaîne, ex. "2" ou "0.5"')
  .refine((value) => /[1-9]/.test(value), 'la quantité doit être strictement positive');
const cursor = z.string().max(200).optional();
const limit = z.coerce.number().int().min(1).max(100).default(20);

// ───────── Grille tarifaire ─────────
export const createPriceListSchema = z.object({
  code,
  name: label,
  currency: currencyCode.optional(),
  isDefault: z.boolean().default(false),
});
export type CreatePriceListInput = z.infer<typeof createPriceListSchema>;

export const updatePriceListSchema = z
  .object({ name: label, isDefault: z.boolean(), isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'aucun champ à modifier');
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;

export const createPriceListItemSchema = z.object({
  code,
  label,
  category: z.enum(ITEM_CATEGORIES),
  unitPrice: moneyAmount,
  isActive: z.boolean().default(true),
  /** Prestation révélant un diagnostic (ex. dépistage) : libellé masqué hors clinique et sur le reçu. */
  isSensitive: z.boolean().default(false),
  printLabel: printLabel.nullable().optional(),
});
export type CreatePriceListItemInput = z.infer<typeof createPriceListItemSchema>;

export const updatePriceListItemSchema = z
  .object({ label, category: z.enum(ITEM_CATEGORIES), unitPrice: moneyAmount, isActive: z.boolean(), isSensitive: z.boolean(), printLabel: printLabel.nullable() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'aucun champ à modifier');
export type UpdatePriceListItemInput = z.infer<typeof updatePriceListItemSchema>;

export const listPriceListItemsSchema = z.object({
  category: z.enum(ITEM_CATEGORIES).optional(),
  q: z.string().trim().min(2).max(100).optional(),
  includeInactive: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  limit,
  cursor,
});
export type ListPriceListItemsInput = z.infer<typeof listPriceListItemsSchema>;

// ───────── Factures patient ─────────
const catalogLine = z.object({ priceListItemId: uuid, quantity: quantity.default('1') });
/** Ligne libre : réservée aux détenteurs de `billing:invoice:update`. */
const freeLine = z.object({
  description: label,
  category: z.enum(ITEM_CATEGORIES).default('autre'),
  unitPrice: moneyAmount,
  quantity: quantity.default('1'),
});
export const invoiceLineInputSchema = z.union([catalogLine, freeLine]);
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>;

const linesSchema = z.array(invoiceLineInputSchema).min(1).max(MAX_INVOICE_LINES);

export const createInvoiceSchema = z.object({
  patientId: uuid,
  siteId: uuid,
  appointmentId: uuid.optional(),
  notes: note.optional(),
  lines: linesSchema,
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const replaceInvoiceLinesSchema = z.object({ lines: linesSchema });
export type ReplaceInvoiceLinesInput = z.infer<typeof replaceInvoiceLinesSchema>;

export const voidInvoiceSchema = z.object({
  reasonCode: z.enum(VOID_REASON_CODES),
  /** Commentaire libre, conservé sur la facture mais jamais dans l'audit. */
  comment: z.string().trim().min(1).max(VOID_COMMENT_MAX).optional(),
});
export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;

export const listInvoicesSchema = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  patientId: uuid.optional(),
  siteId: uuid.optional(),
  limit,
  cursor,
});
export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;

// ───────── Encaissements ─────────
export const recordPaymentSchema = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    amount: positiveMoneyAmount,
    /** Espèces ou autre mode (chèque, virement) : session de caisse ouverte par l'encaisseur, sur le même site que la facture. */
    cashSessionId: uuid.optional(),
    /** Mobile Money : numéro du payeur (haché côté plateforme, jamais journalisé). */
    payerPhone: phoneE164.optional(),
    /** Autre mode (chèque, virement) : référence libre. */
    reference: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.method === 'cash' || value.method === 'other') && !value.cashSessionId) {
      ctx.addIssue({ code: 'custom', path: ['cashSessionId'], message: 'session de caisse obligatoire pour un paiement en espèces ou autre' });
    }
    if (value.method === 'mobile_money' && !value.payerPhone) {
      ctx.addIssue({ code: 'custom', path: ['payerPhone'], message: 'téléphone du payeur obligatoire pour le Mobile Money' });
    }
  });
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

// ───────── Caisse ─────────
export const createCashRegisterSchema = z.object({
  siteId: uuid,
  code,
  name: label,
  currency: currencyCode.optional(),
});
export type CreateCashRegisterInput = z.infer<typeof createCashRegisterSchema>;

export const openCashSessionSchema = z.object({ cashRegisterId: uuid, openingFloat: moneyAmount });
export type OpenCashSessionInput = z.infer<typeof openCashSessionSchema>;

export const closeCashSessionSchema = z.object({ countedAmount: moneyAmount, note: note.optional() });
export type CloseCashSessionInput = z.infer<typeof closeCashSessionSchema>;

/** Clôture contradictoire par un tiers habilité (docs/09 §R8). */
export const forceCloseCashSessionSchema = z.object({ countedAmount: moneyAmount, reason: z.string().trim().min(REASON_MIN).max(VOID_COMMENT_MAX) });
export type ForceCloseCashSessionInput = z.infer<typeof forceCloseCashSessionSchema>;

export const validateCashSessionSchema = z.object({ note: note.optional() });
export type ValidateCashSessionInput = z.infer<typeof validateCashSessionSchema>;

export const listCashSessionsSchema = z.object({
  status: z.enum(CASH_SESSION_STATUSES).optional(),
  mine: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  limit,
  cursor,
});
export type ListCashSessionsInput = z.infer<typeof listCashSessionsSchema>;

// ───────── Contrats de sortie (utilisés par le web) ─────────
// Montants en chaînes décimales à 2 décimales ("25000.00"), quantités en chaînes décimales ; dates ISO 8601.

export interface PriceListView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export interface PriceListItemView {
  readonly id: string;
  readonly priceListId: string;
  readonly code: string;
  readonly label: string;
  readonly category: ItemCategory;
  readonly unitPrice: string;
  readonly isActive: boolean;
  readonly isSensitive: boolean;
  readonly printLabel: string | null;
}

export interface InvoiceLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly priceListItemId: string | null;
  readonly category: ItemCategory;
  /** Libellé rendu : remplacé par le libellé d'impression ou neutre quand `labelMasked` est vrai. */
  readonly description: string;
  readonly isSensitive: boolean;
  readonly labelMasked: boolean;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly lineTotal: string;
}

export interface InvoicePaymentView {
  readonly id: string;
  readonly method: PaymentMethod;
  readonly amount: string;
  readonly currency: string;
  readonly status: (typeof PATIENT_PAYMENT_STATUSES)[number];
  readonly paidAt: string | null;
  readonly cashSessionId: string | null;
  readonly reference: string | null;
  readonly provider: string | null;
  readonly checkoutUrl: string | null;
  readonly failureReason: string | null;
  /** `overpaid` : succès fournisseur au-delà du reste dû (remboursement hors périmètre). */
  readonly anomaly: string | null;
  readonly createdAt: string;
}

export interface InvoiceSummaryView {
  readonly id: string;
  /** Attribué à l'émission (FAC-2026-000123) ; null pour un brouillon. */
  readonly number: string | null;
  readonly status: InvoiceStatus;
  readonly patientId: string;
  readonly siteId: string;
  readonly appointmentId: string | null;
  readonly currency: string;
  readonly total: string;
  readonly amountPaid: string;
  /** Reste dû : total − montant encaissé. */
  readonly balance: string;
  readonly issuedAt: string | null;
  readonly createdAt: string;
}

export interface InvoiceDetailView extends InvoiceSummaryView {
  readonly subtotal: string;
  readonly notes: string | null;
  readonly voidedAt: string | null;
  readonly voidReasonCode: VoidReasonCode | null;
  /** Commentaire libre de l'annulation (jamais dans l'audit). */
  readonly voidReason: string | null;
  /** `fullName` est null et `identityMasked` vrai sans `patients:patient:read`. */
  readonly patient: { readonly id: string; readonly ipp: string; readonly fullName: string | null; readonly identityMasked: boolean };
  readonly lines: readonly InvoiceLineView[];
  readonly payments: readonly InvoicePaymentView[];
}

export interface ReceiptView {
  readonly establishment: string;
  readonly site: string;
  readonly invoice: InvoiceDetailView;
  /** Facture annulée : le web appose le filigrane « ANNULÉE ». */
  readonly voided: boolean;
  readonly printedAt: string;
}

/** Réponse à une demande d'encaissement Mobile Money / carte : le paiement en attente et la consigne du fournisseur. */
export interface OnlinePaymentView {
  readonly payment: InvoicePaymentView;
  readonly checkoutUrl: string | null;
  readonly instructions: string | null;
}

export interface CashRegisterView {
  readonly id: string;
  readonly siteId: string;
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly isActive: boolean;
}

export interface CashSessionView {
  readonly id: string;
  readonly cashRegisterId: string;
  readonly status: CashSessionStatus;
  readonly currency: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly openingFloat: string;
  /** Session ouverte : fond de caisse + espèces encaissées à cet instant ; session clôturée : valeur figée à la clôture. */
  readonly expectedTotal: string;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  readonly closingCounted: string | null;
  /** Montant compté − attendu (négatif = manque). */
  readonly variance: string | null;
  /** Clôture contradictoire par un tiers (force-close). */
  readonly forceClosed: boolean;
  readonly validatedBy: string | null;
  readonly validatedAt: string | null;
}

/** Réponse de `POST /billing/payments/:id/abandon`. */
export interface AbandonPaymentView {
  readonly status: 'cancelled' | 'succeeded';
}
