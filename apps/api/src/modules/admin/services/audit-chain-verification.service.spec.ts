import { describe, expect, it, vi } from 'vitest';
import { GENESIS_HASH, chainHash } from '../../../common/audit/audit-chain';
import { auditPayload } from '../../../common/audit/audit.service';
import type { AuditService } from '../../../common/audit/audit.service';
import type { RequestContext } from '../../../common/context/request-context';
import type { Clock } from '../../../common/time/clock';
import type { TenantDb, TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import type { AuditChainRow } from '../domain/chain-verification';
import type { AuditLogsRepository } from '../repositories/audit-logs.repository';
import { AuditChainVerificationService } from './audit-chain-verification.service';

const TENANT = '018f0000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-10-05T12:00:00.000Z');

function buildChain(count: number): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  let prev: Uint8Array = GENESIS_HASH;
  for (let i = 0; i < count; i += 1) {
    const base = {
      tenantId: TENANT, chainSeq: BigInt(i + 1), occurredAt: new Date(Date.UTC(2026, 9, 5, 10, 0, 0, i)), actorType: 'system', actorUserId: null,
      sessionId: null, ip: null, action: 'x.y', resourceType: null, resourceId: null, patientId: null, outcome: 'success', changes: { i }, requestId: null,
    };
    const hash = chainHash(prev, auditPayload(base));
    rows.push({ ...base, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

function harness(chain: readonly AuditChainRow[]) {
  const record = vi.fn(async () => undefined);
  const chainBatch = vi.fn(async (_tx: TenantTx, _tenant: string, beforeSeq: bigint | undefined, take: number) =>
    chain.filter((row) => beforeSeq === undefined || row.chainSeq < beforeSeq).sort((x, y) => (x.chainSeq < y.chainSeq ? 1 : -1)).slice(0, take),
  );
  const service = new AuditChainVerificationService(
    { run: async (fn: (tx: TenantTx) => Promise<unknown>) => fn({} as TenantTx) } as unknown as TenantDb,
    { chainBatch } as unknown as AuditLogsRepository,
    { record } as unknown as AuditService,
    { requirePrincipal: () => ({ tenantId: TENANT, userId: 'u', sessionId: 's', mfa: true }) } as unknown as RequestContext,
    { now: () => NOW } as Clock,
  );
  return { service, record, chainBatch };
}

describe('AuditChainVerificationService', () => {
  it('renvoie « empty » pour un tenant sans maillon et l’audite', async () => {
    const { service, record } = harness([]);

    const view = await service.verify({ limit: 50000 });

    expect(view).toEqual({ status: 'empty', checkedCount: 0, fromSeq: null, toSeq: null, firstBrokenSeq: null, checkedAt: NOW.toISOString() });
    expect(record).toHaveBeenCalledWith(expect.anything(), TENANT, expect.objectContaining({ action: 'audit.chain_verified', changes: expect.objectContaining({ status: 'empty' }) }));
  });

  it('déclare une chaîne intacte de plusieurs lots (2 500 maillons, relecture par lots de 1 000)', async () => {
    const { service, chainBatch } = harness(buildChain(2500));

    const view = await service.verify({ limit: 50000 });

    expect(view).toMatchObject({ status: 'intact', checkedCount: 2500, fromSeq: '1', toSeq: '2500', firstBrokenSeq: null });
    expect(chainBatch).toHaveBeenCalledTimes(3);
    expect(chainBatch.mock.calls.every((call) => call[3] <= 1000)).toBe(true);
  });

  it('ne relit que les `limit` derniers maillons et ne remonte pas jusqu’à la genèse', async () => {
    const { service } = harness(buildChain(2500));

    const view = await service.verify({ limit: 1000 });

    expect(view).toMatchObject({ status: 'intact', checkedCount: 1000, fromSeq: '1501', toSeq: '2500' });
  });

  it('détecte un maillon altéré, y compris à la frontière de deux lots, et rapporte le plus ancien', async () => {
    const chain = buildChain(2500);
    const altered = chain.map((row) => (row.chainSeq === 1500n || row.chainSeq === 2000n ? { ...row, action: 'effacé' } : row));
    const { service, record } = harness(altered);

    const view = await service.verify({ limit: 50000 });

    expect(view).toMatchObject({ status: 'broken', checkedCount: 2500, firstBrokenSeq: '1500' });
    expect(record).toHaveBeenCalledWith(expect.anything(), TENANT, expect.objectContaining({ changes: expect.objectContaining({ status: 'broken', firstBrokenSeq: '1500' }) }));
  });

  it('détecte un lien rompu entre deux lots (maillon supprimé à la frontière)', async () => {
    const chain = buildChain(2100).filter((row) => row.chainSeq !== 1100n);
    const { service } = harness(chain);

    const view = await service.verify({ limit: 50000 });

    expect(view.status).toBe('broken');
    expect(view.firstBrokenSeq).toBe('1101');
  });
});
