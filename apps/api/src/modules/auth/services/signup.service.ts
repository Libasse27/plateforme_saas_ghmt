import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { SignupResponse, SignupTenantInput } from '@ghmt/shared';
import { PasswordService } from '../../../common/auth/password.service';
import { AuditService } from '../../../common/audit/audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { MAILER, type Mailer } from '../../../common/mail/mailer';
import { RATE_LIMIT_STORE } from '../../../common/rate-limit/rate-limit-runtime';
import type { RateLimitStore } from '../../../common/rate-limit/rate-limit-store';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { TenantProvisioningService } from '../../../infrastructure/tenancy/tenant-provisioning.service';
import { createSignupVerification, deliverSignupVerification } from '../../onboarding/signup-verification';

const UNIQUE_VIOLATION = '23505';
const INVALID_PARAMETER_VALUE = '22023';

interface DriverErrorShape {
  readonly code?: string;
  readonly message?: string;
  readonly meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } };
}

function originalCode(err: unknown): string | undefined {
  const e = err as DriverErrorShape | undefined;
  return e?.meta?.driverAdapterError?.cause?.originalCode ?? e?.meta?.code;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as DriverErrorShape | undefined)?.code === 'P2002' || originalCode(err) === UNIQUE_VIOLATION;
}

/** Refus « reserved slug » de `platform.register_tenant` (contrôle SQL redondant avec `slug_status`). */
function isReservedSlugViolation(err: unknown): boolean {
  const e = err as DriverErrorShape | undefined;
  const message = e?.meta?.driverAdapterError?.cause?.originalMessage ?? e?.message ?? '';
  return originalCode(err) === INVALID_PARAMETER_VALUE && message.includes('reserved slug');
}

type SlugStatus = 'available' | 'taken' | 'reserved';

@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly provisioning: TenantProvisioningService,
    private readonly audit: AuditService,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  /**
   * Crée l'établissement (statut `pending`) et son administrateur, avec un jeton de vérification créé dans la même
   * transaction. L'e-mail part après la validation : un échec d'envoi ne fait pas échouer l'inscription (renvoi possible).
   * Pas de connexion automatique.
   */
  async signup(input: SignupTenantInput): Promise<SignupResponse> {
    const slug = input.establishment.slug;
    const status = await this.slugStatus(slug);
    if (status === 'reserved') throw this.slugReserved();
    if (status === 'taken') throw this.slugTaken();

    const passwordHash = await this.passwords.hash(input.admin.password);
    let token: string | undefined;
    try {
      const provisioned = await this.provisioning.provision(input, passwordHash, undefined, {
        initialStatus: 'pending',
        afterProvision: async (tx, created) => {
          token = await createSignupVerification(tx, { tenantId: created.tenantId, userId: created.adminUserId, now: this.clock.now() });
        },
      });
      if (token) await this.sendVerification(input, provisioned.tenantId, provisioned.adminUserId, token);
      return { tenantId: provisioned.tenantId, slug };
    } catch (err) {
      // Course entre deux inscriptions sur le même identifiant, ou refus SQL d'un identifiant réservé.
      if (isUniqueViolation(err)) throw this.slugTaken();
      if (isReservedSlugViolation(err)) throw this.slugReserved();
      throw err;
    }
  }

  private async sendVerification(input: SignupTenantInput, tenantId: string, userId: string, token: string): Promise<void> {
    const { establishment, admin } = input;
    await deliverSignupVerification(
      { mailer: this.mailer, tenantDb: this.tenantDb, audit: this.audit, store: this.store, webUrl: this.env.WEB_URL, logger: this.logger },
      {
        tenantId,
        userId,
        email: admin.email,
        tenantSlug: establishment.slug,
        token,
        resend: false,
      },
    );
  }

  private async slugStatus(slug: string): Promise<SlugStatus> {
    const rows = await this.tenantDb.runWithoutTenant((tx) => tx.$queryRaw<{ status: SlugStatus }[]>`SELECT platform.slug_status(${slug}) AS status`);
    return rows[0]?.status ?? 'available';
  }

  private slugTaken(): DomainError {
    return DomainError.conflict('slug_taken', 'Cet identifiant d’établissement est déjà utilisé.');
  }

  /** 422 `slug_reserved` portée par le champ `establishment.slug` (docs/11 D13). */
  private slugReserved(): DomainError {
    return new DomainError('slug_reserved', HttpStatus.UNPROCESSABLE_ENTITY, 'Unprocessable Entity', 'Identifiant d’établissement réservé.', {
      errors: [{ path: 'establishment.slug', code: 'slug_reserved', message: 'Cet identifiant d’établissement est réservé : choisissez-en un autre.' }],
    });
  }
}
