import { describe, expect, it, vi } from 'vitest';
import type { TenantTx } from '../../infrastructure/prisma/tenant-db.service';
import type { RequestContext } from '../context/request-context';
import { GENESIS_HASH } from './audit-chain';
import { AuditService } from './audit.service';

const TENANT = '0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function fakeTx(seq: bigint, previous: { hash: Uint8Array } | null) {
  const create = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ seq }]),
    auditLog: { findUnique: vi.fn().mockResolvedValue(previous), create },
  };
  return { tx: tx as unknown as TenantTx, create };
}

const context = { principal: undefined, state: { requestId: 'req-12345678', ip: '10.0.0.1' } } as unknown as RequestContext;

describe('AuditService.record (A7)', () => {
  it('chaîne le premier événement sur le hash de genèse', async () => {
    const { tx, create } = fakeTx(1n, null);
    await new AuditService(context).record(tx, TENANT, { action: 'test.first', actorType: 'system' });
    const data = create.mock.calls[0]![0].data;
    expect(Buffer.from(data.prevHash).equals(GENESIS_HASH)).toBe(true);
    expect(data.chainSeq).toBe(1n);
  });

  it('chaîne un événement ultérieur sur le hash du maillon précédent', async () => {
    const previousHash = new Uint8Array(32).fill(7);
    const { tx, create } = fakeTx(5n, { hash: previousHash });
    await new AuditService(context).record(tx, TENANT, { action: 'test.next', actorType: 'system' });
    expect(Buffer.from(create.mock.calls[0]![0].data.prevHash)).toEqual(Buffer.from(previousHash));
  });

  it('lève une erreur et n’écrit rien si le maillon seq-1 manque (rupture de chaîne)', async () => {
    const { tx, create } = fakeTx(5n, null);
    await expect(new AuditService(context).record(tx, TENANT, { action: 'test.broken', actorType: 'system' })).rejects.toThrow(/rupture/i);
    expect(create).not.toHaveBeenCalled();
  });
});
