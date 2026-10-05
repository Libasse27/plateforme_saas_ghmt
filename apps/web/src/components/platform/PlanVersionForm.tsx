import type { PlatformPlanView } from '@ghmt/shared';
import { PLAN_TIERS } from '@ghmt/shared';
import { createPlanVersionAction } from '@/actions/platform-console';
import { ActionForm, type FieldSpec } from '@/components/forms/ActionForm';
import { FEATURE_FIELDS, LIMIT_FIELDS } from '@/lib/domain/platform';

const TIER_LABELS: Readonly<Record<(typeof PLAN_TIERS)[number], string>> = { basic: 'Basic', standard: 'Standard', professional: 'Professional', enterprise: 'Enterprise' };

function withoutCents(amount: string): string {
  return amount.replace(/\.00$/, '');
}

/** Champs du formulaire « nouvelle version » ; préremplis depuis la version courante d'un plan. */
export function planFormFields(base?: PlatformPlanView): FieldSpec[] {
  const limits = base?.entitlements.limits;
  const features = base?.entitlements.features;
  return [
    { kind: 'text', name: 'code', label: 'Code du plan', required: true, hint: 'Minuscules, chiffres et _. Un code existant crée la version suivante.', ...(base ? { defaultValue: base.code } : {}) },
    { kind: 'text', name: 'name', label: 'Nom', required: true, ...(base ? { defaultValue: base.name } : {}) },
    { kind: 'select', name: 'tier', label: 'Gamme', required: true, options: PLAN_TIERS.map((tier) => ({ value: tier, label: TIER_LABELS[tier] })), ...(base ? { defaultValue: base.tier } : {}) },
    { kind: 'text', name: 'priceMonthly', label: 'Prix mensuel', required: true, inputMode: 'decimal', ...(base ? { defaultValue: withoutCents(base.priceMonthly) } : {}) },
    { kind: 'text', name: 'priceYearly', label: 'Prix annuel', required: true, inputMode: 'decimal', ...(base ? { defaultValue: withoutCents(base.priceYearly) } : {}) },
    { kind: 'text', name: 'currency', label: 'Devise', required: true, defaultValue: base?.currency ?? 'XOF' },
    {
      kind: 'textarea',
      name: 'modules',
      label: 'Modules inclus',
      required: true,
      hint: 'Codes séparés par des virgules ou des retours à la ligne. billing et cashier sont obligatoires.',
      defaultValue: base ? base.entitlements.modules.join(', ') : 'appointments, billing, cashier',
    },
    ...LIMIT_FIELDS.map(
      ([key, label]): FieldSpec => ({
        kind: 'text',
        name: `limits.${key}`,
        label: `Limite : ${label}`,
        hint: 'Vide = illimité.',
        inputMode: 'numeric',
        ...(limits?.[key] !== null && limits?.[key] !== undefined ? { defaultValue: String(limits[key]) } : {}),
      }),
    ),
    ...FEATURE_FIELDS.map(([key, label]): FieldSpec => ({ kind: 'checkbox', name: `features.${key}`, label, defaultChecked: features?.[key] ?? false })),
    { kind: 'checkbox', name: 'isPublic', label: 'Offre publique', hint: 'Visible par les établissements pour le changement de plan.', defaultChecked: base?.isPublic ?? true },
  ];
}

export function PlanVersionForm({ base }: { readonly base?: PlatformPlanView | undefined }) {
  return (
    <ActionForm
      action={createPlanVersionAction}
      idPrefix="plan-"
      fields={planFormFields(base)}
      submitLabel={base ? `Publier la version ${String(base.version + 1)}` : 'Créer le plan'}
      pendingLabel="Publication…"
    />
  );
}
