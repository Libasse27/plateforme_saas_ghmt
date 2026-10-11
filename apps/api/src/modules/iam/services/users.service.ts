import { Injectable } from '@nestjs/common';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { EntitlementService } from '../../../common/authz/entitlement.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { ownerMustTransfer } from './admin-hierarchy';
import { HierarchyService } from './hierarchy.service';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { USER_SELECT, toUserDto } from '../mappers/iam.mappers';
import { SecurityAlertService } from '../../notifications/services/security-alert.service';
import { invalidatePasswordResetTokens } from '../../auth/services/password-reset-tokens';
import { holdsDirectorRole, revokeAllSessions } from './account-security';
import { UserSecurityService } from './user-security.service';
import { UserViewsService } from './user-views.service';
import { assertAnotherActiveAdmin, holdsActiveAdminRole, lockSecuritySettings } from './admin-invariant';
import { AssignmentsService } from './assignments.service';
import { InvitationsService, type IssuedInvitation } from './invitations.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly assignments: AssignmentsService,
    private readonly invitations: InvitationsService,
    private readonly entitlements: EntitlementService,
    private readonly hierarchy: HierarchyService,
    private readonly views: UserViewsService,
    private readonly userSecurity: UserSecurityService,
    private readonly alerts: SecurityAlertService,
  ) {}

  async list(query: ListUsersQuery): Promise<Page<ReturnType<typeof toUserDto>>> {
    const after = decodeUuidCursor(query.cursor);
    const { rows, map } = await this.tenantDb.run(async (tx) => {
      const found = await tx.user.findMany({
        where: {
          deletedAt: null,
          ...(query.status ? { status: query.status } : {}),
          ...(query.q
            ? { OR: [{ fullName: { contains: query.q, mode: 'insensitive' as const } }, { email: { contains: query.q, mode: 'insensitive' as const } }] }
            : {}),
          ...(after ? { id: { gt: after } } : {}),
        },
        select: USER_SELECT,
        orderBy: { id: 'asc' },
        take: query.limit + 1,
      });
      return { rows: found, map: await this.views.mapper(tx, found.slice(0, query.limit)) };
    });
    return Page.fromRows(rows, query.limit, map, (row) => row.id);
  }

  async get(id: string) {
    return this.tenantDb.run(async (tx) => {
      await this.requireUser(tx, id);
      return this.views.detail(tx, id);
    });
  }

  async create(input: CreateUserInput) {
    const principal = this.context.requirePrincipal();
    const created = await this.tenantDb.run(async (tx) => {
      const existing = await tx.user.findFirst({ where: { email: input.email }, select: { id: true } });
      if (existing) throw DomainError.conflict('email_already_used', 'Cette adresse e-mail est déjà utilisée.');
      // Limite dure du plan : utilisateurs actifs + invités (403 plan_limit_reached).
      await this.entitlements.assertCanAddUser(tx);

      // Compte « invité » sans identifiants : le mot de passe est choisi par l'intéressé via le lien reçu par e-mail.
      const user = await tx.user.create({
        data: {
          tenantId: principal.tenantId,
          email: input.email,
          fullName: input.fullName,
          locale: input.locale,
          status: 'invited',
          createdBy: principal.userId,
        },
        select: { id: true },
      });
      for (const assignment of input.roleAssignments) {
        await this.assignments.createInTx(tx, principal.tenantId, user.id, assignment);
      }
      const invitation = await this.invitations.issue(tx, principal.tenantId, user.id, principal.userId);
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.user.created',
        resourceType: 'user',
        resourceId: user.id,
        changes: { after: { status: 'invited', locale: input.locale, assignmentCount: input.roleAssignments.length } },
      });
      await this.audit.record(tx, principal.tenantId, { action: 'iam.user.invited', resourceType: 'user', resourceId: user.id });
      const profile = await loadTenantProfile(tx);
      return { dto: await this.load(tx, user.id), invitation, recipient: { email: input.email, fullName: input.fullName, tenantName: profile.name, tenantSlug: profile.slug } };
    });
    await this.invitations.deliver(created.invitation, created.recipient);
    return created.dto;
  }

  /** Renvoie l'e-mail d'invitation d'un utilisateur encore « invité » ; le jeton précédent est invalidé. */
  async resendInvitation(id: string): Promise<void> {
    const principal = this.context.requirePrincipal();
    const prepared = await this.tenantDb.run(async (tx) => {
      const user = await tx.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, email: true, fullName: true, status: true } });
      if (!user) throw DomainError.notFound('Utilisateur');
      await this.hierarchy.assertCanManageUser(tx, id);
      if (user.status !== 'invited') throw DomainError.conflict('invalid_state', 'Seul un utilisateur invité peut recevoir une nouvelle invitation.');
      const invitation: IssuedInvitation = await this.invitations.issue(tx, principal.tenantId, id, principal.userId);
      await this.audit.record(tx, principal.tenantId, { action: 'iam.user.invitation_resent', resourceType: 'user', resourceId: id });
      const profile = await loadTenantProfile(tx);
      return { invitation, recipient: { email: user.email, fullName: user.fullName, tenantName: profile.name, tenantSlug: profile.slug } };
    });
    await this.invitations.deliver(prepared.invitation, prepared.recipient);
  }

  async update(id: string, input: UpdateUserInput) {
    const principal = this.context.requirePrincipal();
    return this.tenantDb.run(async (tx) => {
      const before = await this.requireUser(tx, id);
      await this.hierarchy.assertCanManageUser(tx, id);
      const data = {
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
      };
      await tx.user.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: { ...data, updatedBy: principal.userId, rowVersion: { increment: 1 } },
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.user.updated',
        resourceType: 'user',
        resourceId: id,
        changes: {
          fields: Object.keys(data),
          before: { locale: before.locale },
          after: { locale: input.locale ?? before.locale },
        },
      });
      return this.load(tx, id);
    });
  }

  async disable(id: string) {
    const principal = this.context.requirePrincipal();
    return this.tenantDb.run(async (tx) => {
      // Sérialisé avec un transfert du titre de principal (verrou pris avant de lire le principal).
      await lockSecuritySettings(tx, principal.tenantId);
      const before = await this.requireUser(tx, id);
      const { ownerUserId } = await this.hierarchy.assertCanManageUser(tx, id);
      if (before.status === 'disabled') return this.load(tx, id);
      if (ownerUserId === id) throw ownerMustTransfer();
      if (await holdsActiveAdminRole(tx, id)) {
        await assertAnotherActiveAdmin(tx, principal.tenantId, { excludeUserId: id });
      }
      const wasDirector = await holdsDirectorRole(tx, id);
      await tx.user.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: { status: 'disabled', updatedBy: principal.userId, rowVersion: { increment: 1 } },
      });
      const revoked = await revokeAllSessions(tx, id, 'user_disabled');
      const resetTokens = await invalidatePasswordResetTokens(tx, principal.tenantId, id, new Date());
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.user.disabled',
        resourceType: 'user',
        resourceId: id,
        changes: { before: { status: before.status }, after: { status: 'disabled' }, revokedSessions: revoked, invalidatedResetTokens: resetTokens },
      });
      if (wasDirector) {
        await this.alerts.establishmentAlert(tx, principal.tenantId, 'security.director_removed', { audience: 'directors_and_owner', actorUserId: principal.userId, targetUserId: id }, new Date());
      }
      return this.load(tx, id);
    });
  }

  async enable(id: string) {
    const principal = this.context.requirePrincipal();
    const outcome = await this.tenantDb.run(async (tx) => {
      const before = await this.requireUser(tx, id);
      await this.hierarchy.assertCanManageUser(tx, id);
      if (before.status === 'active') return { dto: await this.load(tx, id), delayKey: null };
      if (before.status === 'invited') {
        throw DomainError.conflict('invalid_state', 'Un utilisateur invité doit d’abord accepter son invitation.');
      }
      // Un compte désactivé n'est pas compté dans le plan : le réactiver consomme une place.
      if (before.status === 'disabled') await this.entitlements.assertCanAddUser(tx);
      // Sans identifiants (invitation jamais acceptée), le compte ne peut pas être « actif » : retour à « invité »
      // pour que l'invitation puisse être renvoyée.
      const hasCredential = (await tx.userCredential.count({ where: { userId: id } })) > 0;
      const nextStatus = hasCredential ? 'active' : 'invited';
      await tx.user.update({
        where: { tenantId_id: { tenantId: principal.tenantId, id } },
        data: { status: nextStatus, updatedBy: principal.userId, rowVersion: { increment: 1 } },
      });
      await tx.userCredential.updateMany({ where: { userId: id }, data: { failedAttempts: 0 } });
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.user.enabled',
        resourceType: 'user',
        resourceId: id,
        changes: { before: { status: before.status }, after: { status: nextStatus } },
      });
      return { dto: await this.load(tx, id), delayKey: await this.userSecurity.loginDelayKey(tx, id) };
    });
    // Effet hors base APRÈS le commit : une réactivation annulée ne lève pas le délai.
    await this.userSecurity.clearLoginDelay(outcome.delayKey);
    return outcome.dto;
  }

  async revokeSessions(id: string): Promise<void> {
    const principal = this.context.requirePrincipal();
    await this.tenantDb.run(async (tx) => {
      await this.requireUser(tx, id);
      await this.hierarchy.assertCanManageUser(tx, id);
      const revoked = await revokeAllSessions(tx, id, 'revoked_by_admin');
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.session.revoked',
        resourceType: 'user',
        resourceId: id,
        changes: { revokedSessions: revoked },
      });
    });
  }

  private async requireUser(tx: TenantTx, id: string): Promise<{ id: string; status: string; locale: string }> {
    const user = await tx.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, status: true, locale: true } });
    if (!user) throw DomainError.notFound('Utilisateur');
    return user;
  }

  private load(tx: TenantTx, id: string) {
    return this.views.detail(tx, id);
  }

}
