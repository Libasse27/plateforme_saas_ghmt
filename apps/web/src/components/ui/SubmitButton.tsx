'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { buttonClass } from './styles';

export function SubmitButton({
  children,
  pendingLabel = 'Envoi en cours…',
  variant = 'primary',
  disabled = false,
}: {
  readonly children: ReactNode;
  readonly pendingLabel?: string;
  readonly variant?: keyof typeof buttonClass;
  readonly disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  const inactive = pending || disabled;
  return (
    <button type="submit" disabled={inactive} aria-disabled={inactive} className={buttonClass[variant]}>
      {pending ? pendingLabel : children}
    </button>
  );
}
