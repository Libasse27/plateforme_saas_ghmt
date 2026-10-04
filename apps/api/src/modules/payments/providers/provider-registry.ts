import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import type { PaymentProvider } from '../domain/payment-provider';
import { PAYMENTS_FETCH } from '../payments.constants';
import { CinetPayProvider } from './cinetpay.provider';
import { SandboxProvider } from './sandbox.provider';

/** Fournisseurs de paiement connus ; chacun décide lui-même s'il est actif (configuration, environnement). */
@Injectable()
export class ProviderRegistry {
  private readonly providers: ReadonlyMap<string, PaymentProvider>;

  constructor(
    @Inject(ENV) env: Env,
    db: PlatformDb,
    @Inject(PAYMENTS_FETCH) fetchImpl: typeof fetch,
  ) {
    const all: PaymentProvider[] = [new CinetPayProvider(env, fetchImpl), new SandboxProvider(env, db)];
    this.providers = new Map(all.map((provider) => [provider.code, provider]));
  }

  get(code: string): PaymentProvider | undefined {
    return this.providers.get(code);
  }

  /** Le fournisseur s'il existe ET est actif ; sinon undefined (webhook et initiation traités comme « inconnu »). */
  getEnabled(code: string): PaymentProvider | undefined {
    const provider = this.providers.get(code);
    return provider?.isEnabled() ? provider : undefined;
  }
}
