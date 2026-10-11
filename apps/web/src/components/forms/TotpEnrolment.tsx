'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { activateTotpAction, sendMfaEmailCodeAction, startTotpSetupAction } from '@/actions/mfa-setup';
import { EMPTY_FORM_STATE, type FormState } from '@/lib/forms';
import { Alert } from '@/components/ui/Alert';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { buttonClass } from '@/components/ui/styles';

export interface TotpEnrolmentProps {
  /** Actions du realm (défaut : établissement ; la console plateforme fournit les siennes). */
  readonly startSetup?: (emailCode?: string) => Promise<FormState>;
  /** Envoi du code par e-mail exigé hors réseau de confiance (docs/11 D7) ; absent de la console plateforme. */
  readonly sendEmailCode?: () => Promise<FormState>;
  readonly activate?: (prev: FormState, formData: FormData) => Promise<FormState>;
  readonly continueHref?: string;
  /**
   * Facteur déjà actif côté serveur. Décidé ici et non dans la page : l'activation réécrit le cookie de session,
   * ce qui rafraîchit la page serveur ; le composant doit rester monté pour afficher les codes de secours.
   */
  readonly alreadyActive?: boolean;
}

function emailCodeOf(formData: FormData): string | undefined {
  const value = formData.get('emailCode');
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Étape « code par e-mail » : l'API répond 403 `mfa_email_code_required` quand l'enrôlement se fait hors réseau de
 * confiance. L'utilisateur reçoit un code, le saisit, puis seulement le QR code est affiché.
 */
function EmailCodeStep({
  mail,
  mailAction,
  setup,
  startAction,
}: {
  readonly mail: FormState;
  readonly mailAction: () => void;
  readonly setup: FormState;
  readonly startAction: (formData: FormData) => void;
}) {
  const codeSent = mail.ok === true || setup.fieldErrors?.emailCode !== undefined;
  return (
    <section aria-labelledby="etape-mail" className="space-y-4">
      <h2 id="etape-mail" className="text-lg font-semibold">1. Confirmez votre adresse e-mail</h2>
      <p className="text-slate-800">
        Vous êtes en dehors du réseau de votre établissement : pour activer le second facteur, un code à 6 chiffres est envoyé à l&apos;adresse de votre compte.
      </p>
      <form action={mailAction} className="space-y-3">
        <FormMessage state={mail} />
        <SubmitButton pendingLabel="Envoi…" variant={codeSent ? 'secondary' : 'primary'}>{codeSent ? 'Renvoyer le code' : 'Recevoir un code par e-mail'}</SubmitButton>
      </form>
      {codeSent ? (
        <form action={startAction} className="space-y-3" noValidate>
          <TextField
            name="emailCode"
            label="Code reçu par e-mail"
            hint="Code à 6 chiffres, valable 10 minutes. Pas d'accès à votre e-mail ? Contactez votre administrateur."
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            error={setup.fieldErrors?.emailCode}
          />
          <SubmitButton pendingLabel="Vérification…">Valider le code</SubmitButton>
        </form>
      ) : null}
    </section>
  );
}

export function TotpEnrolment({
  startSetup = startTotpSetupAction,
  sendEmailCode = sendMfaEmailCodeAction,
  activate = activateTotpAction,
  continueHref = '/',
  alreadyActive = false,
}: TotpEnrolmentProps = {}) {
  const [setup, startAction] = useActionState(async (_previous: FormState, formData: FormData) => startSetup(emailCodeOf(formData)), EMPTY_FORM_STATE);
  const [mail, mailAction] = useActionState(async () => sendEmailCode(), EMPTY_FORM_STATE);
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

  if (alreadyActive) {
    return (
      <>
        <Alert tone="success">L&apos;authentification à deux facteurs est déjà active sur votre compte.</Alert>
        <Link href={continueHref} className="inline-block font-semibold text-blue-800 underline">Retour au tableau de bord</Link>
      </>
    );
  }

  const qrDataUrl = typeof setup.extra?.qrDataUrl === 'string' ? setup.extra.qrDataUrl : null;
  const secret = typeof setup.extra?.secret === 'string' ? setup.extra.secret : null;

  const trustedNetwork = mail.extra?.emailCodeNotRequired === true;
  const needsEmailCode = setup.extra?.emailCodeRequired === true && !trustedNetwork;

  return (
    <div className="space-y-6">
      {!qrDataUrl && needsEmailCode ? (
        <EmailCodeStep mail={mail} mailAction={mailAction} setup={setup} startAction={startAction} />
      ) : !qrDataUrl ? (
        <form action={startAction} className="space-y-3">
          {trustedNetwork ? <Alert tone="info">Votre réseau est un réseau de confiance : aucun code par e-mail n&apos;est nécessaire.</Alert> : null}
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
