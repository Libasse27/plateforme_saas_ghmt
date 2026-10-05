import { Injectable } from '@nestjs/common';
import type { InAppMessageView, ListInboxQuery, UnreadCountView } from '@ghmt/shared';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { toInAppView } from '../mappers/inapp.mapper';
import { InboxRepository } from '../repositories/inbox.repository';

/** Boîte in-app de l'utilisateur connecté : jamais les messages d'un autre utilisateur ni d'un autre établissement (404). */
@Injectable()
export class InboxService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: InboxRepository,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  list(query: ListInboxQuery): Promise<Page<InAppMessageView>> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const beforeId = decodeUuidCursor(query.cursor);
    return this.db.run(async (tx) => {
      const rows = await this.repo.list(tx, tenantId, userId, { now: this.clock.now(), unreadOnly: query.unreadOnly === 'true', beforeId, take: query.limit + 1 });
      return Page.fromRows(rows, query.limit, toInAppView, (row) => row.id);
    });
  }

  unreadCount(): Promise<UnreadCountView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run((tx) => this.repo.countUnread(tx, tenantId, userId, this.clock.now()));
  }

  markRead(id: string): Promise<InAppMessageView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const now = this.clock.now();
    return this.db.run(async (tx) => {
      if (!(await this.repo.findOwn(tx, tenantId, userId, id, now))) throw DomainError.notFound('Message');
      await this.repo.markRead(tx, tenantId, userId, id, now);
      const updated = await this.repo.findOwn(tx, tenantId, userId, id, now);
      if (!updated) throw DomainError.notFound('Message');
      return toInAppView(updated);
    });
  }

  markAllRead(): Promise<{ updated: number }> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const now = this.clock.now();
    return this.db.run(async (tx) => ({ updated: await this.repo.markAllRead(tx, tenantId, userId, now) }));
  }
}
