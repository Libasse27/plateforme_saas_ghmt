import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { RequestContext } from '../../common/context/request-context';
import { isUuid } from '../../common/pipes/uuid.pipe';
import { PrismaService } from './prisma.service';

export type TenantTx = Prisma.TransactionClient;

const TX_TIMEOUT_MS = 10_000;
const TX_MAX_WAIT_MS = 5_000;

/** Pose le contexte RLS pour la transaction courante (SET LOCAL : aucune fuite entre requêtes). */
export async function applyTenantContext(tx: TenantTx, tenantId: string, userId?: string): Promise<void> {
  if (!isUuid(tenantId)) throw new Error('tenantId invalide');
  if (userId !== undefined && !isUuid(userId)) throw new Error('userId invalide');
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId ?? ''}, true)`;
}

/**
 * Point d'accès unique aux données tenant (docs/02 §4.3).
 * Toute requête métier s'exécute dans une transaction qui porte `app.tenant_id` ;
 * le tenant vient exclusivement du principal authentifié, jamais de la requête.
 */
@Injectable()
export class TenantDb {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
  ) {}

  /** Transaction dans le tenant du principal courant. */
  run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const principal = this.context.requirePrincipal();
    return this.runAs(principal.tenantId, fn, principal.userId);
  }

  /**
   * Transaction dans un tenant explicitement résolu côté serveur.
   * Réservé aux flux pré-authentification (connexion, refresh, onboarding) et aux guards.
   */
  runAs<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>, userId?: string): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await applyTenantContext(tx, tenantId, userId);
        return fn(tx);
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
    );
  }

  /**
   * Transaction SANS contexte tenant : seules les fonctions SECURITY DEFINER de `platform`
   * (resolve_tenant, register_tenant) sont utilisables ; toute table tenant renvoie 0 ligne.
   */
  runWithoutTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS });
  }
}
