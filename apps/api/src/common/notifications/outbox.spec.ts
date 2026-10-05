import { describe, expect, it, vi } from 'vitest';
import type { TenantTx } from '../../infrastructure/prisma/tenant-db.service';
import { enqueueOutboxEvent, outboxPayloadSchema } from './outbox';

const TENANT = '0197a3c0-0000-7000-8000-000000000001';
const APPOINTMENT = '0197a3c0-0000-7000-8000-0000000000a1';

function fakeTx(): { tx: TenantTx; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({});
  return { tx: { notificationOutboxEvent: { create } } as unknown as TenantTx, create };
}

describe('enqueueOutboxEvent', () => {
  it('écrit l’événement dans la transaction fournie, sans autre donnée que des identifiants et des dates', async () => {
    const { tx, create } = fakeTx();

    await enqueueOutboxEvent(tx, TENANT, {
      eventType: 'appointment.rescheduled',
      aggregateId: APPOINTMENT,
      payload: { startsAt: '2026-10-08T14:00:00.000Z', previousStartsAt: '2026-10-07T14:00:00.000Z' },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        eventType: 'appointment.rescheduled',
        aggregateType: 'appointment',
        aggregateId: APPOINTMENT,
        payload: { startsAt: '2026-10-08T14:00:00.000Z', previousStartsAt: '2026-10-07T14:00:00.000Z' },
      },
    });
  });

  it('refuse une charge utile qui porterait autre chose que des dates (garde-fou anti-PHI)', async () => {
    const { tx, create } = fakeTx();
    const payload = { startsAt: '2026-10-08T14:00:00.000Z', reason: 'consultation VIH' } as never;

    await expect(enqueueOutboxEvent(tx, TENANT, { eventType: 'appointment.created', aggregateId: APPOINTMENT, payload })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuse une date mal formée', async () => {
    const { tx } = fakeTx();

    await expect(
      enqueueOutboxEvent(tx, TENANT, { eventType: 'appointment.created', aggregateId: APPOINTMENT, payload: { startsAt: 'demain' } }),
    ).rejects.toThrow();
  });

  it('propage l’échec d’écriture (la transaction métier doit alors être annulée)', async () => {
    const { tx, create } = fakeTx();
    create.mockRejectedValue(new Error('base indisponible'));

    await expect(
      enqueueOutboxEvent(tx, TENANT, { eventType: 'appointment.deleted', aggregateId: APPOINTMENT, payload: { startsAt: '2026-10-08T14:00:00.000Z' } }),
    ).rejects.toThrow('base indisponible');
  });
});

describe('outboxPayloadSchema', () => {
  it('accepte startsAt seul ou avec previousStartsAt', () => {
    expect(outboxPayloadSchema.safeParse({ startsAt: '2026-10-08T14:00:00.000Z' }).success).toBe(true);
    expect(outboxPayloadSchema.safeParse({ startsAt: '2026-10-08T14:00:00.000Z', previousStartsAt: '2026-10-07T14:00:00.000Z' }).success).toBe(true);
    expect(outboxPayloadSchema.safeParse({}).success).toBe(false);
  });
});
