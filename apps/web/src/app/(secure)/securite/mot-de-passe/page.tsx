import type { Metadata } from 'next';
import { Alert } from '@/components/ui/Alert';
import { PasswordChangeForm } from '@/components/forms/PasswordChangeForm';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Changer de mot de passe' };

export default async function PasswordPage() {
  const me = await requireMe({ allowPasswordChange: true });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Changer de mot de passe</h1>
      {me.user.mustChangePassword ? (
        <Alert tone="warning">Vous devez choisir un nouveau mot de passe avant d&apos;accéder à la console.</Alert>
      ) : (
        <p className="text-sm text-slate-800">Vos autres sessions seront déconnectées après le changement.</p>
      )}
      <PasswordChangeForm />
    </div>
  );
}
