import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenService } from './common/auth/access-token.service';
import { PasswordService } from './common/auth/password.service';
import { AuditService } from './common/audit/audit.service';
import { AuthorizationService } from './common/authz/authorization.service';
import { RequestContext } from './common/context/request-context';
import { MAILER, type Mailer } from './common/mail/mailer';
import { MemoryMailer } from './common/mail/memory-mailer';
import { SmtpMailer } from './common/mail/smtp-mailer';
import { RATE_LIMIT_STORE, rateLimitStoreFor } from './common/rate-limit/rate-limit-runtime';
import { RedisLifecycle, redisProvider, REDIS_CLIENT } from './common/redis/redis.provider';
import { BackgroundTasks } from './common/tasks/background-tasks';
import { Clock } from './common/time/clock';
import { FieldCrypto } from './common/crypto/field-crypto.service';
import { ENV, loadEnv, type Env } from './infrastructure/config/env';
import { DomainEventBus } from './common/events/domain-event-bus';
import { PlatformDb } from './infrastructure/prisma/platform-db.service';
import { PlatformPrismaService } from './infrastructure/prisma/platform-prisma.service';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { TenantDb } from './infrastructure/prisma/tenant-db.service';
import { TenantProvisioningService } from './infrastructure/tenancy/tenant-provisioning.service';

const CORE_PROVIDERS = [
  RequestContext,
  PrismaService,
  TenantDb,
  PlatformPrismaService,
  PlatformDb,
  DomainEventBus,
  FieldCrypto,
  AuditService,
  AuthorizationService,
  AccessTokenService,
  PasswordService,
  TenantProvisioningService,
  Clock,
  BackgroundTasks,
];

/** Services transversaux disponibles dans tous les modules métier. */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    // Transport mémoire sous test (aucun SMTP requis) ; SMTP (Mailpit en dev) sinon.
    { provide: MAILER, inject: [ENV], useFactory: (env: Env): Mailer => (env.NODE_ENV === 'test' ? new MemoryMailer() : new SmtpMailer(env)) },
    redisProvider,
    RedisLifecycle,
    // Même instance que celle du limiteur HTTP (`buildThrottlerOptions`) : délai progressif et débit partagent le stockage.
    { provide: RATE_LIMIT_STORE, inject: [ENV], useFactory: (env: Env) => rateLimitStoreFor(env) },
    ...CORE_PROVIDERS,
  ],
  exports: [ENV, MAILER, REDIS_CLIENT, RATE_LIMIT_STORE, ...CORE_PROVIDERS],
})
export class CoreModule {}
