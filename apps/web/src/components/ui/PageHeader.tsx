import type { ReactNode } from 'react';

export function PageHeader({ title, description, actions }: { readonly title: string; readonly description?: string; readonly actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {description ? <p className="mt-1 text-slate-700">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}
