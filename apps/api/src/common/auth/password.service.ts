import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** Argon2id (docs/04 §1.3) : 64 MiB, 3 passes. À calibrer (~250 ms) sur le matériel cible. */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  /** Hash factice calculé une fois : la vérification d'un compte inconnu coûte autant qu'un vrai (anti-énumération). */
  private readonly dummyHash: Promise<string> = argon2.hash('ghmt-dummy-password-for-timing', ARGON2_OPTIONS);

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string | undefined, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash ?? (await this.dummyHash), password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }
}
