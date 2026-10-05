import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  exportAuditLogsSchema,
  listAuditLogsQuerySchema,
  verifyAuditChainQuerySchema,
  type AuditChainVerificationView,
  type AuditLogView,
  type ExportAuditLogsInput,
  type ListAuditLogsQuery,
  type VerifyAuditChainQuery,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import type { Page } from '../../../common/pagination/page';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { AUDIT_EXPORT_THROTTLE, AUDIT_VERIFY_THROTTLE } from '../admin.constants';
import { CurrentPrincipal } from '../../../common/decorators/auth.decorators';
import type { Principal } from '../../../common/context/request-context';
import { AuditVerifyLimiter } from '../services/audit-verify-limiter';
import { AuditChainVerificationService } from '../services/audit-chain-verification.service';
import { AuditExportService } from '../services/audit-export.service';
import { AuditLogsService } from '../services/audit-logs.service';

/** Journal d'audit de l'établissement (docs/10 §6). */
@Controller('audit-logs')
export class AuditLogsController {
  constructor(
    private readonly logs: AuditLogsService,
    private readonly exports: AuditExportService,
    private readonly verification: AuditChainVerificationService,
    private readonly verifyLimiter: AuditVerifyLimiter,
  ) {}

  @Get()
  @RequirePermission('audit:log:read')
  list(@Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery): Promise<Page<AuditLogView>> {
    return this.logs.list(query);
  }

  /** Réponse CSV non enveloppée : le gestionnaire écrit lui-même la réponse et renvoie `undefined`. */
  @Post('export')
  @HttpCode(200)
  @Throttle(AUDIT_EXPORT_THROTTLE)
  @RequirePermission('audit:log:export')
  async export(@Body(new ZodValidationPipe(exportAuditLogsSchema)) body: ExportAuditLogsInput, @Res() res: Response): Promise<undefined> {
    const file = await this.exports.export(body);
    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
      .setHeader('Cache-Control', 'no-store')
      .send(file.content);
    return undefined;
  }

  @Get('verify')
  @Throttle(AUDIT_VERIFY_THROTTLE)
  @RequirePermission('audit:log:read')
  verify(
    @Query(new ZodValidationPipe(verifyAuditChainQuerySchema)) query: VerifyAuditChainQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AuditChainVerificationView> {
    return this.verifyLimiter.run(principal, () => this.verification.verify(query));
  }
}
