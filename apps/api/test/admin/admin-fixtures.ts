import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../../src/common/audit/audit.service';
import type { AuditEvent } from '../../src/common/audit/audit.types';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import type { TenantFixture, UserFixture } from '../helpers/fixtures';

export const API = '/api/v1';
export const AUDIT_LOGS = `${API}/audit-logs`;
export const DASHBOARD = `${API}/dashboards/establishment`;

export const http = (app: INestApplication): ReturnType<typeof request> => request(app.getHttpServer());
export const bearer = (user: Pick<UserFixture, 'token'> | { token: string }): { Authorization: string } => ({ Authorization: `Bearer ${user.token}` });
export const adminOf = (tenant: TenantFixture): { token: string; userId: string } => ({ token: tenant.adminToken, userId: tenant.adminUserId });

/** Écrit des événements dans la chaîne d'audit d'un tenant (même service que l'application). */
export async function seedAudit(app: INestApplication, tenant: TenantFixture, events: readonly AuditEvent[]): Promise<void> {
  const audit = app.get(AuditService);
  await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
    for (const event of events) await audit.record(tx, tenant.tenantId, event);
  });
}

export function auditRows(app: INestApplication, tenant: TenantFixture, action: string) {
  return app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action }, orderBy: { chainSeq: 'asc' } }));
}

export interface BinaryResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

/** Appel HTTP dont le corps est lu en binaire (le BOM et l'empreinte du fichier doivent rester exacts). */
export async function postBinary(app: INestApplication, path: string, token: string, body: Record<string, unknown> = {}): Promise<BinaryResponse> {
  const res = await http(app)
    .post(path)
    .set({ Authorization: `Bearer ${token}` })
    .send(body)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  return { status: res.status, headers: res.headers as BinaryResponse['headers'], body: res.body as Buffer };
}

export const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Place l'abonnement du tenant dans un statut donné (ex. `grace`), sans facturation. */
export async function setSubscriptionStatus(app: INestApplication, tenantId: string, status: 'grace' | 'active'): Promise<void> {
  await app.get(PlatformDb).run((tx) => tx.subscription.update({ where: { tenantId }, data: { status } }));
}
