import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { ENV, type Env } from '../config/env';

/**
 * Client Prisma connecté avec le rôle `ghmt_platform` : CRUD sur le schéma `platform`,
 * AUCUN accès au schéma `tenant` (refusé par PostgreSQL). Réservé aux modules plateforme
 * (console Super Administrateur, abonnements, factures SaaS, paiements).
 */
@Injectable()
export class PlatformPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ adapter: new PrismaPg({ connectionString: env.PLATFORM_DATABASE_URL }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
