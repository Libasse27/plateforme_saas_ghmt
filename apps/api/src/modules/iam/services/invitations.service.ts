import { Inject, Injectable } from '@nestjs/common';
import { issueOpaqueToken } from '../../../common/auth/opaque-token';
import { DomainError } from '../../../common/errors/domain-error';
import { buildInvitationEmail } from '../../../common/mail/invitation-email';
import { MAILER, type Mailer } from '../../../common/mail/mailer';
import { ENV, type Env } from '../../../infrastructure/config/env';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { INVITATION_TTL_HOURS, INVITATION_TTL_MS } from '../iam.constants';

export interface IssuedInvitation {
  /** Jeton en clair : sert uniquement à composer l'e-mail, jamais renvoyé par l'API ni journalisé. */
  readonly token: string;
}

export interface InvitationRecipient {
  readonly email: string;
  readonly fullName: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
}

/** Émission et envoi des invitations (C6) : jeton 256 bits, empreinte SHA-256 en base, TTL 72 h. */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Invalide les invitations précédentes de l'utilisateur puis en crée une nouvelle, dans la transaction de l'appelant. */
  async issue(tx: TenantTx, tenantId: string, userId: string, createdBy: string): Promise<IssuedInvitation> {
    await tx.invitation.deleteMany({ where: { tenantId, userId } });
    const issued = issueOpaqueToken(tenantId);
    await tx.invitation.create({
      data: { tenantId, userId, tokenHash: issued.hash, expiresAt: new Date(Date.now() + INVITATION_TTL_MS), createdBy },
    });
    return { token: issued.token };
  }

  /** À appeler APRÈS le commit : un échec d'envoi n'annule pas la création, l'administrateur peut renvoyer l'invitation. */
  async deliver(invitation: IssuedInvitation, recipient: InvitationRecipient): Promise<void> {
    const message = buildInvitationEmail({
      to: recipient.email,
      fullName: recipient.fullName,
      tenantName: recipient.tenantName,
      tenantSlug: recipient.tenantSlug,
      webUrl: this.env.WEB_URL,
      token: invitation.token,
      ttlHours: INVITATION_TTL_HOURS,
    });
    try {
      await this.mailer.send(message);
    } catch {
      // Ni le message ni l'erreur brute ne sont journalisés : ils pourraient contenir le lien.
      throw new DomainError(
        'invitation_email_failed',
        502,
        'Bad Gateway',
        'L’e-mail d’invitation n’a pas pu être envoyé. Utilisez « renvoyer l’invitation » une fois le service de messagerie rétabli.',
      );
    }
  }
}
