import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import { TOTP_EPOCH_TOLERANCE_SECONDS, TOTP_ISSUER } from '../auth.constants';

export type TotpVerification = { readonly valid: false } | { readonly valid: true; readonly step: number };

export interface TotpVerifyOptions {
  /** Dernier pas accepté : tout pas inférieur ou égal est refusé (anti-rejeu). */
  readonly lastUsedStep?: number | null;
  /** Horloge injectable (ms) pour les tests. */
  readonly nowMs?: number;
}

@Injectable()
export class TotpService {
  generateSecret(): string {
    return generateSecret();
  }

  buildUri(secret: string, accountLabel: string): string {
    return generateURI({ issuer: TOTP_ISSUER, label: accountLabel, secret });
  }

  async verify(secret: string, code: string, options: TotpVerifyOptions = {}): Promise<TotpVerification> {
    const nowMs = options.nowMs ?? Date.now();
    try {
      const result = await verify({
        secret,
        token: code,
        epoch: Math.floor(nowMs / 1000),
        epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
        ...(options.lastUsedStep != null ? { afterTimeStep: options.lastUsedStep } : {}),
      });
      return result.valid && 'timeStep' in result ? { valid: true, step: result.timeStep } : { valid: false };
    } catch {
      // Secret ou code mal formé : refus, jamais d'exception vers l'appelant.
      return { valid: false };
    }
  }
}
