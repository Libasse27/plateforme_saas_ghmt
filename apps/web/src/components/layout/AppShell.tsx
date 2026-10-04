import Link from 'next/link';
import type { ReactNode } from 'react';
import { logoutAction } from '@/actions/auth';
import { visibleNav } from '@/lib/auth/nav';
import type { Me } from '@/lib/auth/me';
import { Alert } from '@/components/ui/Alert';
import { buttonClass } from '@/components/ui/styles';
import type { Banner } from '@/lib/domain/subscription';
import { NavLink } from './NavLink';

export function AppShell({ me, banner, children }: { readonly me: Me; readonly banner?: Banner | null | undefined; readonly children: ReactNode }) {
  const items = visibleNav(me);
  return (
    <div className="min-h-screen bg-slate-50 md:flex">
      <a href="#contenu" className="sr-only print:hidden focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:bg-white focus:p-2">
        Aller au contenu
      </a>
      <aside className="print:hidden border-b border-slate-300 bg-white md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="px-4 py-3">
          <p className="text-lg font-bold text-blue-900">GHMT</p>
          <p className="text-sm text-slate-700">{me.tenant.name}</p>
        </div>
        <nav aria-label="Navigation principale" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {items.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>
        <div className="hidden border-t border-slate-200 px-4 py-3 md:block">
          <UserBox me={me} />
        </div>
      </aside>
      <div className="flex-1">
        {banner ? (
          <div className="print:hidden" data-testid="subscription-banner">
            <Alert tone={banner.tone}>
              {banner.message}{' '}
              <Link href="/abonnement" className="font-semibold underline">Voir l&apos;abonnement</Link>
            </Alert>
          </div>
        ) : null}
        <div className="flex items-center justify-between border-b border-slate-300 bg-white px-4 py-2 md:hidden print:hidden">
          <UserBox me={me} />
        </div>
        <main id="contenu" className="mx-auto max-w-5xl p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function UserBox({ me }: { readonly me: Me }) {
  return (
    <div className="flex items-center gap-3 md:flex-col md:items-start">
      <p className="text-sm text-slate-900">{me.user.fullName}</p>
      <form action={logoutAction}>
        <button type="submit" className={buttonClass.secondary}>Se déconnecter</button>
      </form>
    </div>
  );
}
