import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NOTIFICATION_TYPES, type NotificationChannel, type NotificationTypeCode, type ScopeType } from '@ghmt/shared';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { deliveryDeadline } from '../domain/appointment-plan';
import { dedupKey } from '../domain/dedup-key';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { RecipientsRepository, type UserRecipient } from '../repositories/recipients.repository';

const TYPE_CODE = 'security.sensitive_role_assigned';
const CHANNELS: readonly NotificationChannel[] = NOTIFICATION_TYPES[TYPE_CODE].channels;

/** Alertes d'établissement (docs/11 §14.1), hors affectation sensible. */
export type EstablishmentAlertType =
  | 'security.trusted_network_changed'
  | 'security.policy_changed'
  | 'security.mfa_reset'
  | 'security.owner_transferred'
  | 'security.director_removed'
  | 'security.login_delay_alert';

/** `directors_and_owner` : directeurs et administrateur principal ; `administrators` : principal et administrateurs. */
export type AlertAudience = 'directors_and_owner' | 'administrators';

export interface EstablishmentAlert {
  readonly audience: AlertAudience;
  /** Auteur de l'opération : jamais destinataire de sa propre alerte. */
  readonly actorUserId?: string | null;
  /** Personne visée (nom repris dans le message) : jamais destinataire non plus, sauf mention contraire dans `include`. */
  readonly targetUserId?: string | null;
  /** Destinataires ajoutés d'office (ex. le nouveau principal). */
  readonly include?: readonly string[];
  /** Identifiant de l'événement (déduplication) ; généré s'il est omis. */
  readonly subjectId?: string;
}

/** Sujet de l'alerte : type, objet visé et clé de déduplication (`subjectId`). */
interface AlertSubject {
  readonly typeCode: NotificationTypeCode;
  readonly subjectType: 'user_role_assignment' | 'security_event';
  readonly subjectId: string;
}

export interface SensitiveRoleAssignment {
  readonly assignmentId: string;
  readonly targetUserId: string;
  readonly roleName: string;
  readonly scopeType: ScopeType;
  readonly actorUserId: string;
}

/**
 * Alertes de sécurité (docs/11 D10) : une affectation de rôle sensible est signalée, dans la transaction de l'affectation,
 * aux directeurs (hors acteur et cible), à défaut à l'administrateur principal. Aucune donnée patient ; le nom du site
 * ou du service visé n'est jamais transmis, seulement le type de portée.
 */
@Injectable()
export class SecurityAlertService {
  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly recipients: RecipientsRepository,
  ) {}

  /** Retourne le nombre de destinataires notifiés (0 : l'audit reste la seule trace). */
  async sensitiveRoleAssigned(tx: TenantTx, tenantId: string, assignment: SensitiveRoleAssignment, now: Date): Promise<number> {
    const excluded = new Set([assignment.actorUserId, assignment.targetUserId]);
    const recipients = await this.resolveRecipients(tx, tenantId, excluded, now);
    if (recipients.length === 0) return 0;

    const [target, actor] = await Promise.all([
      tx.user.findUnique({ where: { tenantId_id: { tenantId, id: assignment.targetUserId } }, select: { fullName: true } }),
      tx.user.findUnique({ where: { tenantId_id: { tenantId, id: assignment.actorUserId } }, select: { fullName: true } }),
    ]);
    const context = {
      targetUserId: assignment.targetUserId,
      targetName: target?.fullName ?? '',
      roleName: assignment.roleName,
      scopeType: assignment.scopeType,
      actorName: actor?.fullName ?? '',
    };
    const subject: AlertSubject = { typeCode: TYPE_CODE, subjectType: 'user_role_assignment', subjectId: assignment.assignmentId };
    for (const recipient of recipients) {
      for (const channel of CHANNELS) await this.insert(tx, tenantId, subject, recipient, channel, context, now);
    }
    return recipients.length;
  }

  /**
   * Alerte d'établissement aux directeurs / administrateurs selon l'audience, dans la transaction de l'opération.
   * Retourne le nombre de destinataires ; aucun destinataire ⇒ l'audit reste la trace.
   */
  async establishmentAlert(tx: TenantTx, tenantId: string, typeCode: EstablishmentAlertType, alert: EstablishmentAlert, now: Date): Promise<number> {
    const excluded = new Set([alert.actorUserId, alert.targetUserId].filter((id): id is string => typeof id === 'string'));
    const recipients = (await this.audienceOf(tx, tenantId, alert, now)).filter((r) => !excluded.has(r.id) || (alert.include ?? []).includes(r.id));
    const extra = await Promise.all((alert.include ?? []).filter((id) => !recipients.some((r) => r.id === id)).map((id) => this.recipients.findActiveUser(tx, tenantId, id)));
    const all = [...recipients, ...extra.filter((r): r is UserRecipient => r !== null)];
    if (all.length === 0) return 0;

    const subjectId = alert.subjectId ?? randomUUID();
    const [actor, target] = await Promise.all([this.nameOf(tx, tenantId, alert.actorUserId), this.nameOf(tx, tenantId, alert.targetUserId)]);
    const context = { ...(alert.targetUserId ? { targetUserId: alert.targetUserId } : {}), targetName: target, actorName: actor };
    const subject: AlertSubject = { typeCode, subjectType: 'security_event', subjectId };
    for (const recipient of all) {
      for (const channel of NOTIFICATION_TYPES[typeCode].channels) await this.insert(tx, tenantId, subject, recipient, channel, context, now);
    }
    return all.length;
  }

  private async audienceOf(tx: TenantTx, tenantId: string, alert: EstablishmentAlert, now: Date): Promise<UserRecipient[]> {
    const settings = await tx.securitySettings.findFirst({ select: { ownerUserId: true } });
    const owner = settings?.ownerUserId ? await this.recipients.findActiveUser(tx, tenantId, settings.ownerUserId) : null;
    const group = alert.audience === 'administrators' ? await this.recipients.findAdministrators(tx, tenantId, now) : await this.recipients.findDirectors(tx, tenantId, now);
    const byId = new Map([...group, ...(owner ? [owner] : [])].map((r) => [r.id, r]));
    return [...byId.values()];
  }

  private async nameOf(tx: TenantTx, tenantId: string, userId: string | null | undefined): Promise<string> {
    if (!userId) return '';
    return (await tx.user.findUnique({ where: { tenantId_id: { tenantId, id: userId } }, select: { fullName: true } }))?.fullName ?? '';
  }

  /** Notification d'alerte (une par destinataire et par canal), dédupliquée par sujet. */
  private async insert(tx: TenantTx, tenantId: string, subject: AlertSubject, recipient: UserRecipient, channel: NotificationChannel, context: Record<string, unknown>, now: Date): Promise<void> {
    const { typeCode, subjectType, subjectId } = subject;
    await this.notifications.insert(
      tx,
      tenantId,
      {
        typeCode,
        category: NOTIFICATION_TYPES[typeCode].category,
        channel,
        recipientType: 'user',
        recipientId: recipient.id,
        subjectType,
        subjectId,
        subjectVersion: null,
        sourceEventId: null,
        dedupKey: dedupKey({ tenantId, sourceKey: subjectId, typeCode, recipientType: 'user', recipientId: recipient.id, channel }),
        locale: recipient.locale === 'en' ? 'en' : 'fr',
        context,
        suppressionReason: null,
        scheduledAt: now,
        deadlineAt: deliveryDeadline({ typeCode, category: 'administrative', channel, scheduledAt: now, startsAt: now }),
      },
      now,
    );
  }

  private async resolveRecipients(tx: TenantTx, tenantId: string, excluded: ReadonlySet<string>, now: Date): Promise<UserRecipient[]> {
    const directors = (await this.recipients.findDirectors(tx, tenantId, now)).filter((d) => !excluded.has(d.id));
    if (directors.length > 0) return directors;
    const settings = await tx.securitySettings.findFirst({ select: { ownerUserId: true } });
    const ownerId = settings?.ownerUserId;
    if (!ownerId || excluded.has(ownerId)) return [];
    const owner = await this.recipients.findActiveUser(tx, tenantId, ownerId);
    return owner ? [owner] : [];
  }
}
