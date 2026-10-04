import type { UsageRow } from '@/lib/domain/subscription';

export function UsagePanel({ rows }: { readonly rows: readonly UsageRow[] }) {
  return (
    <ul className="space-y-4" aria-label="Usage du plan">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{row.label}</span>
            <span className={row.over ? 'font-semibold text-red-800' : 'text-slate-800'}>
              {row.used} {row.limit === null ? '(illimité)' : `sur ${String(row.limit)}`}
            </span>
          </div>
          {row.limit !== null ? (
            <progress
              className="mt-1 h-2 w-full"
              value={Math.min(row.used, row.limit)}
              max={Math.max(row.limit, 1)}
              aria-label={`${row.label} : ${String(row.used)} sur ${String(row.limit)}`}
            />
          ) : null}
          {row.over ? <p className="text-sm text-red-800">Limite dépassée : passez à un plan supérieur pour continuer sans restriction.</p> : null}
          {!row.over && row.atLimit ? <p className="text-sm text-amber-900">Limite atteinte.</p> : null}
        </li>
      ))}
    </ul>
  );
}
