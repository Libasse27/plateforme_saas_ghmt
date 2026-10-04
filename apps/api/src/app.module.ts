import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ACCOUNT_THROTTLER } from './common/throttle/account-throttle';
import { sanitizeLogUrl } from './common/logging/sanitize-url';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionGuard } from './common/guards/permission.guard';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { CoreModule } from './core.module';
import { HealthController } from './health.controller';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AuthModule } from './modules/auth/auth.module';
import { IamModule } from './modules/iam/iam.module';
import { OrgModule } from './modules/org/org.module';
import { PatientsModule } from './modules/patients/patients.module';

const DEFAULT_RATE_LIMIT = { ttl: 60_000, limit: 300 } as const;

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env['LOG_LEVEL'] ?? 'info',
        // Jamais de secrets ni de corps de requête (données de santé) dans les logs techniques.
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        serializers: { req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: sanitizeLogUrl(req.url) }) },
      },
    }),
    ThrottlerModule.forRoot([DEFAULT_RATE_LIMIT, ACCOUNT_THROTTLER]),
    CoreModule,
    AuthModule,
    OrgModule,
    IamModule,
    PatientsModule,
    AppointmentsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Ordre d'exécution : limitation de débit → authentification → autorisation.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
