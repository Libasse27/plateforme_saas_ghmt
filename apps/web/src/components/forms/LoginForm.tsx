'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { loginAction } from '@/actions/auth';
import { EMPTY_FORM_STATE, type FormState } from '@/lib/forms';
import { FormMessage } from '@/components/ui/FormMessage';
import { TextField } from '@/components/ui/Field';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { buttonClass } from '@/components/ui/styles';

const MAX_DELAY_SECONDS = 86_400;
const ONE_SECOND_MS = 1000;
const TICK_MS = 250;

/** Secondes d'attente renvoyées par un 429 `login_delayed` ; 0 si absentes ou incohérentes. */
function delayOf(state: FormState): number {
  const value = state.extra?.retryAfterSeconds;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_DELAY_SECONDS ? value : 0;
}

function verificationTenantOf(state: FormState): string | null {
  const value = state.extra?.verificationTenant;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Compte à rebours du délai progressif (docs/11 D3), calé sur une échéance et non sur des décréments : un onglet
 * en arrière-plan, dont les minuteries sont ralenties, affiche quand même le bon temps restant.
 */
function useLoginDelay(state: FormState): number {
  const [seenState, setSeenState] = useState(state);
  const [remaining, setRemaining] = useState(() => delayOf(state));

  if (state !== seenState) {
    setSeenState(state);
    setRemaining(delayOf(state));
  }

  useEffect(() => {
    const seconds = delayOf(state);
    if (seconds === 0) return undefined;
    const deadline = Date.now() + seconds * ONE_SECOND_MS;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / ONE_SECOND_MS));
      setRemaining(left);
      if (left === 0) clearInterval(timer);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [state]);

  return remaining;
}

export function LoginForm({ next, defaultTenant }: { readonly next: string; readonly defaultTenant?: string }) {
  const [state, formAction] = useActionState(loginAction, EMPTY_FORM_STATE);
  const remaining = useLoginDelay(state);
  const verificationTenant = verificationTenantOf(state);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {verificationTenant ? (
        <p className="text-sm">
          <Link href={`/inscription/verifier?etablissement=${encodeURIComponent(verificationTenant)}`} className="font-semibold text-blue-800 underline">
            Renvoyer l&apos;e-mail de confirmation
          </Link>
        </p>
      ) : null}
      <input type="hidden" name="next" value={next} />
      <TextField
        name="tenantSlug"
        label="Code établissement"
        hint="Fourni lors de l'inscription, par exemple clinique-sante."
        required
        autoComplete="organization"
        autoCapitalize="none"
        defaultValue={state.values?.tenantSlug ?? defaultTenant}
        error={errors.tenantSlug}
      />
      <TextField name="email" type="email" label="Adresse e-mail" required autoComplete="username" defaultValue={state.values?.email} error={errors.email} />
      <TextField name="password" type="password" label="Mot de passe" required autoComplete="current-password" error={errors.password} />
      {remaining > 0 ? (
        <button type="submit" disabled aria-disabled="true" className={buttonClass.primary}>
          Réessayez dans {remaining} s
        </button>
      ) : (
        <SubmitButton pendingLabel="Connexion…">Se connecter</SubmitButton>
      )}
      <p className="text-sm">
        <Link href="/mot-de-passe-oublie" className="font-semibold text-blue-800 underline">Mot de passe oublié ?</Link>
      </p>
    </form>
  );
}
