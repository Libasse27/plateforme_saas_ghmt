import { Injectable, Logger } from '@nestjs/common';
import type { DomainEventMap, DomainEventType } from './domain-events';

type Handler<T extends DomainEventType> = (payload: DomainEventMap[T]) => Promise<void>;

/**
 * Bus d'événements en mémoire du monolithe modulaire : un module publie, d'autres réagissent,
 * sans dépendance directe. Les gestionnaires s'exécutent séquentiellement ; une erreur est
 * journalisée (sans charge utile) et propagée à l'émetteur, qui décide du rejeu.
 * Cible : outbox transactionnelle + BullMQ (docs/01 §3) quand les workers seront en place.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly handlers = new Map<DomainEventType, Handler<DomainEventType>[]>();

  subscribe<T extends DomainEventType>(type: T, handler: Handler<T>): void {
    const current = this.handlers.get(type) ?? [];
    this.handlers.set(type, [...current, handler as Handler<DomainEventType>]);
  }

  async publish<T extends DomainEventType>(type: T, payload: DomainEventMap[T]): Promise<void> {
    for (const handler of this.handlers.get(type) ?? []) {
      try {
        await handler(payload);
      } catch (error: unknown) {
        this.logger.error({ event: type, error: error instanceof Error ? error.name : 'unknown' }, 'Échec d’un gestionnaire d’événement');
        throw error;
      }
    }
  }
}
