import { AsyncLocalStorage } from 'node:async_hooks';
import type { INestApplication } from '@nestjs/common';
import { vi } from 'vitest';
import { TenantDb, type TenantTx } from '../../src/infrastructure/prisma/tenant-db.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { LoginDelayService } from '../../src/modules/auth/services/login-delay.service';

/** Méthodes du délai progressif qui atteignent le stockage de limitation (Redis en production). */
const STORE_METHODS = ['admit', 'release', 'clear', 'claimSuspiciousAlert', 'claimDelayedAudit'] as const;
type StoreMethod = (typeof STORE_METHODS)[number];
type TxFn = (tx: TenantTx) => Promise<unknown>;

/** Instance du module auth (le module iam déclare la sienne : `app.get` ne garantit pas laquelle). */
export const authDelayService = (app: INestApplication): LoginDelayService => app.select(AuthModule).get(LoginDelayService, { strict: true });

/**
 * Trace des appels au stockage de limitation faits PENDANT une transaction Postgres (docs/11 §14.2) : une latence Redis
 * ne doit jamais immobiliser une connexion du pool, ni un effet Redis précéder le commit. `calls` liste les méthodes
 * appelées dans une transaction, `all` tous les appels ; `restore` rend les implémentations d'origine.
 */
export function traceStoreCallsInTransactions(app: INestApplication): { readonly calls: StoreMethod[]; readonly all: StoreMethod[]; restore: () => void } {
  const inTx = new AsyncLocalStorage<true>();
  const calls: StoreMethod[] = [];
  const all: StoreMethod[] = [];
  const db = app.get(TenantDb);
  const wrap = (fn: TxFn): TxFn => (tx) => inTx.run(true, () => fn(tx));

  const runAs = db.runAs.bind(db);
  const runWithoutTenant = db.runWithoutTenant.bind(db);
  const spies = [
    vi.spyOn(db, 'runAs').mockImplementation(((tenantId: string, fn: TxFn, userId?: string) => runAs(tenantId, wrap(fn), userId)) as TenantDb['runAs']),
    vi.spyOn(db, 'runWithoutTenant').mockImplementation(((fn: TxFn) => runWithoutTenant(wrap(fn))) as TenantDb['runWithoutTenant']),
  ];

  const delay = authDelayService(app);
  for (const method of STORE_METHODS) {
    const original = (delay[method] as (...args: unknown[]) => Promise<unknown>).bind(delay);
    spies.push(
      vi.spyOn(delay, method).mockImplementation(((...args: unknown[]) => {
        all.push(method);
        if (inTx.getStore()) calls.push(method);
        return original(...args);
      }) as never),
    );
  }
  return { calls, all, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}
