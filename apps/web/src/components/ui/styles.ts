const BASE =
  'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

export const buttonClass = {
  primary: `${BASE} bg-blue-700 text-white hover:bg-blue-800`,
  secondary: `${BASE} border border-slate-400 bg-white text-slate-900 hover:bg-slate-100`,
  danger: `${BASE} bg-red-700 text-white hover:bg-red-800`,
} as const;

export const inputClass =
  'block w-full rounded-md border border-slate-500 bg-white px-3 py-2 text-base text-slate-900 aria-[invalid=true]:border-red-700';
