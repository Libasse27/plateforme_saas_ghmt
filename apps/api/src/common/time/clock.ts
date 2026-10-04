import { Injectable } from '@nestjs/common';

/** Horloge injectable : les règles dépendantes de l'heure (rendez-vous) restent testables sans simuler Date. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
