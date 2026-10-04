import { Clock } from '../../src/common/time/clock';

/** Horloge pilotable pour les tests du cycle de vie : `set` / `advanceDays` déplacent « maintenant ». */
export class MutableClock extends Clock {
  private current: Date;

  constructor(start: Date = new Date()) {
    super();
    this.current = start;
  }

  override now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = new Date(date);
  }

  advanceDays(days: number): Date {
    this.current = new Date(this.current.getTime() + days * 24 * 60 * 60 * 1000);
    return this.now();
  }

  /** Retour à l'heure réelle (les jetons d'accès et sessions restent valides). */
  reset(): void {
    this.current = new Date();
  }
}
