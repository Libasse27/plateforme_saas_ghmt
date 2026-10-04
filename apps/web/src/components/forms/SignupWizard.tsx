'use client';

import { useActionState, useState } from 'react';
import { CURRENCIES, ESTABLISHMENT_TYPES } from '@ghmt/shared';
import { signupAction } from '@/actions/auth';
import { COUNTRY_PRESETS, CURRENCY_LABELS, ESTABLISHMENT_TYPE_LABELS, presetFor } from '@/lib/domain/labels';
import { EMPTY_FORM_STATE, formDataToFlat } from '@/lib/forms';
import { ADMIN_PASSWORD_HINT, SIGNUP_STEPS, stepIndexOfFirstError, validateSignupStep } from '@/lib/signup-steps';
import { buttonClass } from '@/components/ui/styles';
import { SelectField, TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';

const TYPE_OPTIONS = ESTABLISHMENT_TYPES.map((value) => ({ value, label: ESTABLISHMENT_TYPE_LABELS[value] }));
const COUNTRY_OPTIONS = COUNTRY_PRESETS.map((c) => ({ value: c.code, label: c.name }));
const CURRENCY_OPTIONS = CURRENCIES.map((value) => ({ value, label: CURRENCY_LABELS[value] ?? value }));
const TIMEZONE_OPTIONS = [...new Set(COUNTRY_PRESETS.map((c) => c.timezone))].map((value) => ({ value, label: value }));
const LAST_STEP = SIGNUP_STEPS.length - 1;

export function SignupWizard() {
  const [state, formAction] = useActionState(signupAction, EMPTY_FORM_STATE);
  const [step, setStep] = useState(0);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [seenState, setSeenState] = useState(state);

  if (state !== seenState) {
    setSeenState(state);
    setClientErrors({});
    if (state.fieldErrors) setStep(stepIndexOfFirstError(state.fieldErrors));
  }

  const errors = Object.keys(clientErrors).length > 0 ? clientErrors : (state.fieldErrors ?? {});
  const values = state.values ?? {};

  function goNext(event: React.MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    const current = SIGNUP_STEPS[step];
    if (!form || !current) return;
    const found = validateSignupStep(current.key, formDataToFlat(new FormData(form)));
    setClientErrors(found);
    if (Object.keys(found).length === 0) setStep(step + 1);
  }

  function onCountryChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const preset = presetFor(event.target.value);
    const elements = event.target.form?.elements;
    if (!preset || !elements) return;
    const currency = elements.namedItem('establishment.baseCurrency');
    const timezone = elements.namedItem('establishment.timezone');
    if (currency instanceof HTMLSelectElement) currency.value = preset.currency;
    if (timezone instanceof HTMLSelectElement) timezone.value = preset.timezone;
  }

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <ol className="flex gap-2 text-sm" aria-label="Étapes de l'inscription">
        {SIGNUP_STEPS.map((s, index) => (
          <li
            key={s.key}
            aria-current={index === step ? 'step' : undefined}
            className={`rounded-full px-3 py-1 ${index === step ? 'bg-blue-700 font-semibold text-white' : 'bg-slate-200 text-slate-900'}`}
          >
            {index + 1}. {s.title}
          </li>
        ))}
      </ol>
      <FormMessage state={state} />

      <fieldset hidden={step !== 0} className="space-y-4">
        <legend className="mb-2 text-lg font-semibold">Votre établissement</legend>
        <TextField
          name="establishment.slug"
          label="Code établissement"
          hint="Minuscules, chiffres et tirets (3 à 48 caractères). Il servira à vous connecter."
          required
          autoCapitalize="none"
          defaultValue={values['establishment.slug']}
          error={errors['establishment.slug']}
        />
        <TextField name="establishment.legalName" label="Raison sociale" required defaultValue={values['establishment.legalName']} error={errors['establishment.legalName']} />
        <TextField name="establishment.tradeName" label="Nom commercial" defaultValue={values['establishment.tradeName']} error={errors['establishment.tradeName']} />
        <SelectField name="establishment.establishmentType" label="Type d'établissement" required options={TYPE_OPTIONS} placeholder="Choisir…" defaultValue={values['establishment.establishmentType']} error={errors['establishment.establishmentType']} />
        <div className="space-y-1">
          <label htmlFor="f-establishment-countryCode" className="block text-sm font-medium text-slate-900">
            Pays <span aria-hidden="true" className="text-red-700">*</span>
          </label>
          <select
            id="f-establishment-countryCode"
            name="establishment.countryCode"
            defaultValue={values['establishment.countryCode'] ?? 'SN'}
            onChange={onCountryChange}
            aria-invalid={errors['establishment.countryCode'] ? true : undefined}
            className="block w-full rounded-md border border-slate-500 bg-white px-3 py-2 text-base text-slate-900"
          >
            {COUNTRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {errors['establishment.countryCode'] ? <p className="text-sm font-medium text-red-700">{errors['establishment.countryCode']}</p> : null}
        </div>
        <SelectField name="establishment.baseCurrency" label="Devise" required options={CURRENCY_OPTIONS} defaultValue={values['establishment.baseCurrency'] ?? 'XOF'} error={errors['establishment.baseCurrency']} />
        <SelectField name="establishment.timezone" label="Fuseau horaire" required options={TIMEZONE_OPTIONS} defaultValue={values['establishment.timezone'] ?? 'Africa/Dakar'} error={errors['establishment.timezone']} />
      </fieldset>

      <fieldset hidden={step !== 1} className="space-y-4">
        <legend className="mb-2 text-lg font-semibold">Site principal</legend>
        <TextField name="mainSite.code" label="Code du site" hint="Par exemple SIEGE." required defaultValue={values['mainSite.code'] ?? 'SIEGE'} error={errors['mainSite.code']} />
        <TextField name="mainSite.name" label="Nom du site" required defaultValue={values['mainSite.name']} error={errors['mainSite.name']} />
        <TextField name="mainSite.city" label="Ville" defaultValue={values['mainSite.city']} error={errors['mainSite.city']} />
      </fieldset>

      <fieldset hidden={step !== 2} className="space-y-4">
        <legend className="mb-2 text-lg font-semibold">Compte administrateur</legend>
        <TextField name="admin.fullName" label="Nom complet" required autoComplete="name" defaultValue={values['admin.fullName']} error={errors['admin.fullName']} />
        <TextField name="admin.email" type="email" label="Adresse e-mail" required autoComplete="email" defaultValue={values['admin.email']} error={errors['admin.email']} />
        <TextField name="admin.password" type="password" label="Mot de passe" hint={ADMIN_PASSWORD_HINT} required autoComplete="new-password" error={errors['admin.password']} />
        <TextField name="admin.confirmPassword" type="password" label="Confirmer le mot de passe" required autoComplete="new-password" error={errors['admin.confirmPassword']} />
      </fieldset>

      <div className="flex flex-wrap gap-3">
        {step > 0 ? (
          <button type="button" className={buttonClass.secondary} onClick={() => { setClientErrors({}); setStep(step - 1); }}>
            Précédent
          </button>
        ) : null}
        {step < LAST_STEP ? (
          <button type="button" className={buttonClass.primary} onClick={goNext}>Suivant</button>
        ) : (
          <SubmitButton pendingLabel="Création en cours…">Créer l&apos;établissement</SubmitButton>
        )}
      </div>
    </form>
  );
}
