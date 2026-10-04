import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { EffectiveGrant } from '../authz/authorization.types';
import { DomainError } from '../errors/domain-error';

/** Identité authentifiée issue d'un JWT vérifié et d'une session active. */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  /** Second facteur vérifié pendant cette session. */
  readonly mfa: boolean;
}

export interface RequestContextState {
  readonly requestId: string;
  readonly ip?: string;
  readonly userAgent?: string;
  principal?: Principal;
  grants?: readonly EffectiveGrant[];
}

const storage = new AsyncLocalStorage<RequestContextState>();

/**
 * Contexte de requête propagé par AsyncLocalStorage (docs/03 §1.3).
 * Le principal et les droits ne sont posés qu'une fois, par les guards.
 */
@Injectable()
export class RequestContext {
  run<T>(state: RequestContextState, fn: () => T): T {
    return storage.run(state, fn);
  }

  get state(): RequestContextState | undefined {
    return storage.getStore();
  }

  get requestId(): string | undefined {
    return storage.getStore()?.requestId;
  }

  get principal(): Principal | undefined {
    return storage.getStore()?.principal;
  }

  get grants(): readonly EffectiveGrant[] {
    return storage.getStore()?.grants ?? [];
  }

  requirePrincipal(): Principal {
    const principal = this.principal;
    if (!principal) throw DomainError.unauthorized();
    return principal;
  }

  setPrincipal(principal: Principal): void {
    const store = this.requireStore();
    if (store.principal) throw new Error('Principal déjà défini pour cette requête');
    store.principal = Object.freeze({ ...principal });
  }

  setGrants(grants: readonly EffectiveGrant[]): void {
    const store = this.requireStore();
    store.grants = Object.freeze([...grants]);
  }

  private requireStore(): RequestContextState {
    const store = storage.getStore();
    if (!store) throw new Error('RequestContext utilisé hors d’une requête');
    return store;
  }
}
