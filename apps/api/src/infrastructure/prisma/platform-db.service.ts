import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PlatformPrismaService } from './platform-prisma.service';

export type PlatformTx = Prisma.TransactionClient;

const TX_TIMEOUT_MS = 10_000;
const TX_MAX_WAIT_MS = 5_000;

/** Accès transactionnel au schéma `platform` (rôle ghmt_platform, aucune donnée patient accessible). */
@Injectable()
export class PlatformDb {
  constructor(private readonly prisma: PlatformPrismaService) {}

  run<T>(fn: (tx: PlatformTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS });
  }
}
