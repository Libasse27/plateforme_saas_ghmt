import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createTrustedNetworkSchema,
  removeTrustedNetworkSchema,
  transferOwnershipSchema,
  updateSecurityPolicySchema,
  type CreateTrustedNetworkInput,
  type RemoveTrustedNetworkInput,
  type SecurityPolicyView,
  type TransferOwnershipInput,
  type TrustedNetworkView,
  type UpdateSecurityPolicyInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { SecurityService } from '../services/security.service';

/** `DELETE` sans corps : le code manquant donne 401 `mfa_step_up_required`, pas une erreur de validation. */
const OPTIONAL_REMOVAL_BODY = removeTrustedNetworkSchema.optional();

/**
 * Politique de sécurité de l'établissement (docs/11 §5.4, §14.1). Les écritures sont réservées au principal avec un code TOTP
 * (`owner_required`, `mfa_step_up_required`, `mfa_code_invalid`) : contrôles faits par le service.
 */
@Controller('iam/security')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @Get('policy')
  @RequirePermission('iam:policy:read')
  policy(): Promise<SecurityPolicyView> {
    return this.security.getPolicy();
  }

  @Patch('policy')
  @RequirePermission('iam:policy:update')
  updatePolicy(@Body(new ZodValidationPipe(updateSecurityPolicySchema)) body: UpdateSecurityPolicyInput): Promise<SecurityPolicyView> {
    return this.security.updatePolicy(body);
  }

  @Post('trusted-networks')
  @RequirePermission('iam:policy:update')
  addNetwork(@Body(new ZodValidationPipe(createTrustedNetworkSchema)) body: CreateTrustedNetworkInput): Promise<TrustedNetworkView> {
    return this.security.addNetwork(body);
  }

  @Delete('trusted-networks/:id')
  @HttpCode(204)
  @RequirePermission('iam:policy:update')
  removeNetwork(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodValidationPipe(OPTIONAL_REMOVAL_BODY)) body: RemoveTrustedNetworkInput | undefined,
  ): Promise<void> {
    return this.security.removeNetwork(id, body?.totpCode);
  }

  @Post('owner')
  @HttpCode(200)
  @RequirePermission('iam:policy:update')
  transferOwner(@Body(new ZodValidationPipe(transferOwnershipSchema)) body: TransferOwnershipInput): Promise<SecurityPolicyView> {
    return this.security.transferOwnership(body.userId, body.totpCode);
  }
}
