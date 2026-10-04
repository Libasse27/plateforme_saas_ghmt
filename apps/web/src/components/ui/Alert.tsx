import type { ReactNode } from 'react';

const TONES = {
  error: 'border-red-700 bg-red-50 text-red-900',
  success: 'border-green-700 bg-green-50 text-green-900',
  info: 'border-blue-700 bg-blue-50 text-blue-900',
  warning: 'border-amber-700 bg-amber-50 text-amber-900',
} as const;

export function Alert({ tone, children }: { readonly tone: keyof typeof TONES; readonly children: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border-l-4 px-4 py-3 text-sm ${TONES[tone]}`}>
      {children}
    </div>
  );
}
