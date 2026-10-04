'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { buttonClass } from './styles';

export function SubmitButton({
  children,
  pendingLabel = 'Envoi en cours…',
  variant = 'primary',
}: {
  readonly children: ReactNode;
  readonly pendingLabel?: string;
  readonly variant?: keyof typeof buttonClass;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending} className={buttonClass[variant]}>
      {pending ? pendingLabel : children}
    </button>
  );
}
