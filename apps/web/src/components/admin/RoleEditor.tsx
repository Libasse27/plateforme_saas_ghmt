'use client';

import { useActionState } from 'react';
import { createRoleAction, updateRoleAction } from '@/actions/admin-roles';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import type { MatrixModule, RoleDetailView } from '@/lib/domain/admin';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { RoleMatrix } from './RoleMatrix';

export interface RoleEditorProps {
  readonly role?: RoleDetailView;
  readonly matrix: readonly MatrixModule[];
  readonly held: readonly string[];
}

/** Formulaire de rôle personnalisé : identité + matrice de permissions (le rôle système n'utilise pas ce composant). */
export function RoleEditor({ role, matrix, held }: RoleEditorProps) {
  const [state, formAction] = useActionState(role ? updateRoleAction : createRoleAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} noValidate className="space-y-4">
      <FormMessage state={state} />
      {role ? <input type="hidden" name="id" value={role.id} /> : null}
      {role ? null : (
        <TextField name="code" label="Code" required hint="Minuscules, chiffres et tirets bas, 3 à 50 caractères." defaultValue={state.values?.code ?? ''} error={errors.code} />
      )}
      <TextField name="name" label="Nom" required defaultValue={state.values?.name ?? role?.name ?? ''} error={errors.name} />
      <TextField name="description" label="Description" defaultValue={state.values?.description ?? role?.description ?? ''} error={errors.description} />
      <div>
        <h2 className="mb-2 text-lg font-semibold">Permissions</h2>
        <p className="mb-3 text-sm text-slate-800">Vous ne pouvez accorder que les permissions que vous détenez vous-même ; les autres cases sont grisées.</p>
        {errors.permissions ? <p className="mb-2 text-sm font-medium text-red-700">{errors.permissions}</p> : null}
        <RoleMatrix matrix={matrix} selected={role?.permissions ?? []} held={held} />
      </div>
      <SubmitButton pendingLabel="Enregistrement…">{role ? 'Enregistrer le rôle' : 'Créer le rôle'}</SubmitButton>
    </form>
  );
}
