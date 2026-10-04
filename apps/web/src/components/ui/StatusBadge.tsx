import type { DisplayStatus } from '@/lib/domain/appointments';
import { APPOINTMENT_STATUS_LABELS } from '@/lib/domain/labels';

const TONES: Readonly<Record<DisplayStatus, string>> = {
  requested: 'bg-slate-200 text-slate-900',
  scheduled: 'bg-slate-200 text-slate-900',
  confirmed: 'bg-blue-100 text-blue-900',
  checked_in: 'bg-green-100 text-green-900',
  in_progress: 'bg-green-200 text-green-900',
  completed: 'bg-green-100 text-green-900',
  cancelled: 'bg-red-100 text-red-900',
  no_show: 'bg-amber-100 text-amber-900',
  unknown: 'bg-amber-100 text-amber-900',
};

export function StatusBadge({ status }: { readonly status: DisplayStatus }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[status]}`}>{APPOINTMENT_STATUS_LABELS[status]}</span>;
}
