'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isActivePath } from '@/lib/auth/active-path';

export function NavLink({ href, label, exact = false }: { readonly href: string; readonly label: string; readonly exact?: boolean }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : isActivePath(href, pathname);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium ${active ? 'bg-blue-700 text-white' : 'text-slate-900 hover:bg-slate-200'}`}
    >
      {label}
    </Link>
  );
}
