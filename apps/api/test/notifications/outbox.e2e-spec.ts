import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueOutboxEvent } from '../../src/common/notifications/outbox';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createDepartmentRow, createPractitionerRow } from '../appointments/appointment-fixtures';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createReceptionistWith } from '../patients/patient-fixtures';
import { API, DAY_MS, bearer, bookAppointment, createPatientWithContacts, futureStart, http, outboxOf } from './notification-fixtures';

describe('outbox transactionnelle des rendez-vous', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let receptionist: UserFixture;
  let remover: UserFixture;
  let patientId: string;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'outbox' });
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    remover = await createReceptionistWith(app, tenant, ['appointments:appointment:delete']);
    patientId = await createPatientWithContacts(app, tenant);
  });

  afterAll(async () => {
    await app?.close();
  });

  const startsAt = futureStart(20);

  it('la création d’un rendez-vous écrit exactement un événement appointment.created, sans donnée de santé', async () => {
    const id = await bookAppointment(app, tenant, receptionist, { patientId, startsAt, reason: 'Motif très confidentiel' });

    const events = await outboxOf(app, tenant, { aggregateId: id });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'appointment.created', aggregateType: 'appointment', status: 'pending', attempts: 0 });
    expect(events[0]?.payload).toEqual({ startsAt: startsAt.toISOString() });
    expect(JSON.stringify(events[0])).not.toContain('confidentiel');
  });

  it('une création en échec (409 chevauchement) n’écrit aucun événement', async () => {
    const practitionerId = await createPractitionerRow(app, tenant);
    const first = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: futureStart(21), practitionerId });
    const before = await outboxOf(app, tenant);

    const res = await http(app)
      .post(`${API}/appointments`)
      .set(bearer(receptionist.token))
      .send({
        patientId,
        practitionerId,
        siteId: tenant.mainSiteId,
        startsAt: futureStart(21).toISOString(),
        endsAt: new Date(futureStart(21).getTime() + 30 * 60_000).toISOString(),
      })
      .expect(409);

    expect(res.body.error?.code ?? res.body.code).toBeDefined();
    expect(await outboxOf(app, tenant)).toHaveLength(before.length);
    expect(await outboxOf(app, tenant, { aggregateId: first })).toHaveLength(1);
  });

  it('enqueueOutboxEvent suivi d’une exception dans la même transaction ne laisse aucune ligne', async () => {
    const aggregateId = '0197a3c0-0000-7000-8000-00000000f001';

    await expect(
      app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
        await enqueueOutboxEvent(tx, tenant.tenantId, { eventType: 'appointment.created', aggregateId, payload: { startsAt: startsAt.toISOString() } });
        throw new Error('échec métier après l’écriture');
      }),
    ).rejects.toThrow('échec métier');

    expect(await outboxOf(app, tenant, { aggregateId })).toHaveLength(0);
  });

  it('le report écrit appointment.rescheduled avec l’ancien et le nouvel horaire', async () => {
    const id = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: futureStart(22) });
    const next = new Date(futureStart(22).getTime() + DAY_MS);

    await http(app)
      .patch(`${API}/appointments/${id}/reschedule`)
      .set(bearer(receptionist.token))
      .send({ startsAt: next.toISOString(), endsAt: new Date(next.getTime() + 30 * 60_000).toISOString() })
      .expect(200);

    const events = await outboxOf(app, tenant, { aggregateId: id, eventType: 'appointment.rescheduled' });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ startsAt: next.toISOString(), previousStartsAt: futureStart(22).toISOString() });
  });

  it('le passage au statut cancelled écrit appointment.cancelled ; un autre statut n’écrit rien', async () => {
    const cancelled = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: futureStart(23) });
    const confirmed = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: futureStart(24) });

    await http(app).post(`${API}/appointments/${confirmed}/status`).set(bearer(receptionist.token)).send({ status: 'confirmed' }).expect(200);
    await http(app)
      .post(`${API}/appointments/${cancelled}/status`)
      .set(bearer(receptionist.token))
      .send({ status: 'cancelled', cancelReason: 'Motif d’annulation confidentiel' })
      .expect(200);

    const cancelEvents = await outboxOf(app, tenant, { aggregateId: cancelled, eventType: 'appointment.cancelled' });
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0]?.payload).toEqual({ startsAt: futureStart(23).toISOString() });
    expect(JSON.stringify(cancelEvents[0])).not.toContain('confidentiel');
    const confirmedEvents = await outboxOf(app, tenant, { aggregateId: confirmed });
    expect(confirmedEvents.map((e) => e.eventType)).toEqual(['appointment.created']);
  });

  it('la suppression écrit appointment.deleted', async () => {
    const id = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: futureStart(25) });

    await http(app).delete(`${API}/appointments/${id}`).set(bearer(remover.token)).expect(204);

    const events = await outboxOf(app, tenant, { aggregateId: id, eventType: 'appointment.deleted' });
    expect(events).toHaveLength(1);
  });

  it('isole les événements entre établissements (RLS)', async () => {
    const other = await createTenantFixture(app, { prefix: 'outbox-b' });

    expect(await outboxOf(app, other)).toHaveLength(0);
    await createDepartmentRow(app, other, other.mainSiteId);
    expect((await outboxOf(app, tenant)).length).toBeGreaterThan(0);
  });
});
