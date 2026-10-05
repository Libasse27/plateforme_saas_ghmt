'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { activateTotpAction, startTotpSetupAction } from '@/actions/mfa-setup';
import { EMPTY_FORM_STATE, type FormState } from '@/lib/forms';
import { Alert } from '@/components/ui/Alert';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { buttonClass } from '@/components/ui/styles';

export interface TotpEnrolmentProps {
  /** Actions du realm (défaut : établissement ; la console plateforme fournit les siennes). */
  readonly startSetup?: () => Promise<FormState>;
  readonly activate?: (prev: FormState, formData: FormData) => Promise<FormState>;
  readonly continueHref?: string;
}

export function TotpEnrolment({ startSetup = startTotpSetupAction, activate = activateTotpAction, continueHref = '/' }: TotpEnrolmentProps = {}) {
  const [setup, startAction] = useActionState(async () => startSetup(), EMPTY_FORM_STATE);
  const [activation, activateAction] = useActionState(activate, EMPTY_FORM_STATE);

  const backupCodes = (activation.extra?.backupCodes ?? []) as readonly string[];
  if (activation.ok) {
    return (
      <div className="space-y-4">
        <FormMessage state={activation} />
        <Alert tone="warning">
          Conservez ces codes de secours dans un endroit sûr. Chacun ne sert qu&apos;une fois et <strong>ils ne seront plus affichés</strong>.
        </Alert>
        <ul className="grid grid-cols-2 gap-2 rounded-md border border-slate-400 bg-white p-4 font-mono text-base" aria-label="Codes de secours">
          {backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <Link href={continueHref} className={buttonClass.primary}>J&apos;ai conservé mes codes, continuer</Link>
      </div>
    );
  }

  const qrDataUrl = typeof setup.extra?.qrDataUrl === 'string' ? setup.extra.qrDataUrl : null;
  const secret = typeof setup.extra?.secret === 'string' ? setup.extra.secret : null;

  return (
    <div className="space-y-6">
      {!qrDataUrl ? (
        <form action={startAction} className="space-y-3">
          <FormMessage state={setup} />
          <p className="text-slate-800">
            Vous aurez besoin d&apos;une application d&apos;authentification (Google Authenticator, FreeOTP, Microsoft Authenticator…).
          </p>
          <SubmitButton pendingLabel="Génération…">Générer le QR code</SubmitButton>
        </form>
      ) : (
        <>
          <section aria-labelledby="etape-scan" className="space-y-3">
            <h2 id="etape-scan" className="text-lg font-semibold">1. Scannez le QR code</h2>
            {/* eslint-disable-next-line @next/next/no-img-element -- QR en data URL SVG généré côté serveur */}
            <img src={qrDataUrl} alt="QR code d'enrôlement à scanner avec votre application d'authentification" width={200} height={200} className="border border-slate-300 bg-white p-2" />
            {secret ? (
              <p className="text-sm text-slate-800">
                Impossible de scanner ? Saisissez cette clé manuellement : <code className="break-all rounded bg-slate-200 px-1 font-mono">{secret}</code>
              </p>
            ) : null}
          </section>
          <section aria-labelledby="etape-code" className="space-y-3">
            <h2 id="etape-code" className="text-lg font-semibold">2. Saisissez le code affiché</h2>
            <form action={activateAction} className="space-y-4" noValidate>
              <FormMessage state={activation} />
              <TextField name="code" label="Code à 6 chiffres" required inputMode="numeric" autoComplete="one-time-code" error={activation.fieldErrors?.code} />
              <SubmitButton pendingLabel="Vérification…">Activer l&apos;authentification</SubmitButton>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
