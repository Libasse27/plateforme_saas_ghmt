const TONES = {
  neutral: 'bg-slate-200 text-slate-900',
  info: 'bg-blue-100 text-blue-900',
  success: 'bg-green-100 text-green-900',
  warning: 'bg-amber-100 text-amber-900',
  danger: 'bg-red-100 text-red-900',
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({ tone = 'neutral', children }: { readonly tone?: BadgeTone; readonly children: string }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}
