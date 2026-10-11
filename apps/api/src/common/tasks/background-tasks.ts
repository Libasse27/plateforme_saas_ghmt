import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

/**
 * Travail exécuté APRÈS l'envoi de la réponse HTTP (docs/11 D8) : la réponse de `POST /auth/password/forgot` ne dépend
 * ni de l'existence du compte ni du temps d'envoi de l'e-mail. `drain()` laisse les tests attendre la fin des tâches.
 */
@Injectable()
export class BackgroundTasks implements OnApplicationShutdown {
  private readonly logger = new Logger(BackgroundTasks.name);
  private readonly pending = new Set<Promise<void>>();

  /** Planifie `task` au prochain tour de boucle ; une erreur est journalisée (nom de l'erreur seul, jamais le message). */
  run(label: string, task: () => Promise<void>): void {
    const promise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(task)
      .catch((error: unknown) => {
        this.logger.error(`Tâche d’arrière-plan « ${label} » en échec (${error instanceof Error ? error.name : 'inconnue'}).`);
      })
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
  }

  /** Attend la fin de toutes les tâches, y compris celles lancées pendant l'attente. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }
}
