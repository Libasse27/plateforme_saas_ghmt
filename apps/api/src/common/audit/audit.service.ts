import { Injectable } from '@nestjs/common';
import { RequestContext } from '../context/request-context';
import type { TenantTx } from '../../infrastructure/prisma/tenant-db.service';
import { GENESIS_HASH, chainHash } from './audit-chain';
import type { AuditEvent } from './audit.types';

function toBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

/** Charge utile hachée : doit rester stable (toute évolution = nouvelle version de chaîne). */
export function auditPayload(row: {
  tenantId: string;
  chainSeq: bigint;
  occurredAt: Date;
  actorType: string;
  actorUserId: string | null;
  sessionId: string | null;
  ip: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  patientId: string | null;
  outcome: string;
  changes: unknown;
  requestId: string | null;
}): Record<string, unknown> {
  // Liste explicite : une ligne relue en base (avec id, hash…) doit produire la même empreinte.
  return {
    tenantId: row.tenantId,
    chainSeq: row.chainSeq.toString(),
    occurredAt: row.occurredAt.toISOString(),
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    sessionId: row.sessionId,
    ip: row.ip,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    patientId: row.patientId,
    outcome: row.outcome,
    changes: row.changes,
    requestId: row.requestId,
  };
}

/** `patientIds` (lectures groupées : recherche, liste d'agenda) est conservé dans `changes`, jamais en colonne dédiée. */
function mergeChanges(event: AuditEvent): Record<string, unknown> | null {
  if (!event.changes && !event.patientIds) return null;
  return { ...event.changes, ...(event.patientIds ? { patientIds: [...event.patientIds] } : {}) };
}

/**
 * Journal d'audit append-only chaîné par tenant (docs/04 §7).
 * S'écrit dans la transaction métier : pas d'action sans trace, pas de trace sans action.
 * Le numéro de chaîne vient de tenant.next_sequence('audit'), qui sérialise les écritures d'un tenant.
 */
@Injectable()
export class AuditService {
  constructor(private readonly context: RequestContext) {}

  async record(tx: TenantTx, tenantId: string, event: AuditEvent): Promise<void> {
    const [{ seq }] = await tx.$queryRaw<{ seq: bigint }[]>`SELECT tenant.next_sequence('audit') AS seq`;
    const previous =
      seq > 1n
        ? await tx.auditLog.findUnique({ where: { tenantId_chainSeq: { tenantId, chainSeq: seq - 1n } }, select: { hash: true } })
        : null;
    // Un maillon manquant (seq-1 absent) est une rupture de la chaîne : on refuse d'écrire plutôt que de repartir de la genèse.
    if (seq > 1n && !previous) throw new Error(`Rupture de la chaîne d'audit : maillon ${(seq - 1n).toString()} introuvable`);
    const prevHash = previous ? Buffer.from(previous.hash) : GENESIS_HASH;

    const principal = this.context.principal;
    const state = this.context.state;
    const row = {
      tenantId,
      chainSeq: seq,
      occurredAt: new Date(),
      actorType: event.actorType ?? (principal || event.actorUserId ? 'user' : 'anonymous'),
      actorUserId: event.actorUserId ?? principal?.userId ?? null,
      sessionId: principal?.sessionId ?? null,
      ip: state?.ip ?? null,
      action: event.action,
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ?? null,
      patientId: event.patientId ?? null,
      outcome: event.outcome ?? 'success',
      changes: mergeChanges(event),
      requestId: state?.requestId ?? null,
    };
    const hash = chainHash(prevHash, auditPayload(row));

    await tx.auditLog.create({
      data: {
        ...row,
        changes: row.changes === null ? undefined : (row.changes as object),
        prevHash: toBytes(prevHash),
        hash: toBytes(hash),
      },
    });
  }
}
