'use client';

import { buttonClass } from '@/components/ui/styles';

export function PrintButton({ label = 'Imprimer' }: { readonly label?: string }) {
  return (
    <button type="button" className={`${buttonClass.primary} print:hidden`} onClick={() => { window.print(); }}>
      {label}
    </button>
  );
}
