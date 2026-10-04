import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { RequestContext } from '../context/request-context';
import type { PlatformTx } from '../../infrastructure/prisma/platform-db.service';

export type PlatformActor =
  | { readonly type: 'platform_user'; readonly userId: string; readonly role: string }
  | { readonly type: 'tenant_user'; readonly userId: string }
  | { readonly type: 'system' }
  | { readonly type: 'anonymous' };

export interface PlatformAuditEvent {
  readonly action: string;
  readonly actor: PlatformActor;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly tenantId?: string;
  readonly outcome?: 'success' | 'denied' | 'failure';
  /** Identifiants, statuts et montants uniquement : jamais de donnée clinique ni de secret. */
  readonly changes?: Readonly<Record<string, unknown>>;
}

/**
 * Journal d'audit plateforme (`platform.audit_logs`, ajout seul par trigger). Toute action de la console,
 * tout changement d'état d'abonnement et toute écriture de facturation SaaS y laissent une trace,
 * dans la même transaction que l'action.
 */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly context: RequestContext) {}

  async record(tx: PlatformTx, event: PlatformAuditEvent): Promise<void> {
    const state = this.context.state;
    const actor = event.actor;
    const ip = state?.ip && isIP(state.ip) ? state.ip : null;
    await tx.platformAuditLog.create({
      data: {
        actorType: actor.type,
        actorUserId: actor.type === 'platform_user' || actor.type === 'tenant_user' ? actor.userId : null,
        actorRole: actor.type === 'platform_user' ? actor.role : null,
        action: event.action,
        resourceType: event.resourceType ?? null,
        resourceId: event.resourceId ?? null,
        tenantId: event.tenantId ?? null,
        outcome: event.outcome ?? 'success',
        ip,
        requestId: state?.requestId ?? null,
        changes: (event.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
