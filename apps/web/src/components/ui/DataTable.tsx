import type { ReactNode } from 'react';

export interface Column {
  readonly header: string;
  /** Colonne d'actions : l'en-tête est réservé aux lecteurs d'écran. */
  readonly hiddenHeader?: boolean;
  readonly align?: 'right';
}

/** Tableau accessible (légende, en-têtes de colonnes) ; les lignes sont fournies par l'appelant. */
export function DataTable({ caption, columns, children }: { readonly caption: string; readonly columns: readonly Column[]; readonly children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-slate-100">
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col" className={`px-3 py-2 ${column.align === 'right' ? 'text-right' : ''}`}>
                {column.hiddenHeader ? <span className="sr-only">{column.header}</span> : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, align, className = '' }: { readonly children: ReactNode; readonly align?: 'right'; readonly className?: string }) {
  return <td className={`border-t border-slate-200 px-3 py-2 align-top ${align === 'right' ? 'text-right tabular-nums' : ''} ${className}`}>{children}</td>;
}
