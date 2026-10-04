import type { ReactNode } from 'react';
import { platformLogoutAction } from '@/actions/platform-auth';
import { buttonClass } from '@/components/ui/styles';
import { visiblePlatformNav, type PlatformMeView } from '@/lib/auth/platform-me';
import { NavLink } from './NavLink';

const ROLE_LABELS: Readonly<Record<string, string>> = { super_admin: 'Super administrateur', support: 'Support', billing: 'Facturation' };

export function PlatformShell({ me, children }: { readonly me: PlatformMeView; readonly children: ReactNode }) {
  const items = visiblePlatformNav(me);
  return (
    <div className="min-h-screen bg-slate-50 md:flex">
      <a href="#contenu" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:bg-white focus:p-2">
        Aller au contenu
      </a>
      <aside className="border-b border-slate-300 bg-white md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="px-4 py-3">
          <p className="text-lg font-bold text-blue-900">GHMT Plateforme</p>
          <p className="text-sm text-slate-700">{ROLE_LABELS[me.role] ?? me.role}</p>
        </div>
        <nav aria-label="Navigation plateforme" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {items.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} exact={item.href === '/plateforme'} />
          ))}
        </nav>
        <div className="flex items-center gap-3 border-t border-slate-200 px-4 py-3 md:flex-col md:items-start">
          <p className="text-sm text-slate-900">{me.fullName}</p>
          <form action={platformLogoutAction}>
            <button type="submit" className={buttonClass.secondary}>Se déconnecter</button>
          </form>
        </div>
      </aside>
      <main id="contenu" className="mx-auto w-full max-w-5xl flex-1 p-4 md:p-8">
        {children}
      </main>
    </div>
  );
}
