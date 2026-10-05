import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  closeCashSessionSchema,
  createCashRegisterSchema,
  forceCloseCashSessionSchema,
  listCashSessionsSchema,
  openCashSessionSchema,
  validateCashSessionSchema,
  type CashRegisterView,
  type CashSessionView,
  type CloseCashSessionInput,
  type CreateCashRegisterInput,
  type ForceCloseCashSessionInput,
  type ListCashSessionsInput,
  type OpenCashSessionInput,
  type ValidateCashSessionInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import type { Page } from '../../../common/pagination/page';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { CashRegistersService } from '../services/cash-registers.service';
import { CashSessionsService } from '../services/cash-sessions.service';

/** Caisse (docs/09 §C2) : caisses, sessions, clôture et validation avec séparation des tâches. */
@Controller('cashier')
export class CashierController {
  constructor(
    private readonly registers: CashRegistersService,
    private readonly sessions: CashSessionsService,
  ) {}

  @Get('registers')
  @RequirePermission('cashier:cash_session:read')
  listRegisters(): Promise<CashRegisterView[]> {
    return this.registers.list();
  }

  @Post('registers')
  @RequirePermission('cashier:cash_session:validate')
  createRegister(@Body(new ZodValidationPipe(createCashRegisterSchema)) body: CreateCashRegisterInput): Promise<CashRegisterView> {
    return this.registers.create(body);
  }

  @Get('sessions')
  @RequirePermission('cashier:cash_session:read')
  listSessions(@Query(new ZodValidationPipe(listCashSessionsSchema)) query: ListCashSessionsInput): Promise<Page<CashSessionView>> {
    return this.sessions.list(query);
  }

  @Post('sessions')
  @RequirePermission('cashier:cash_session:create')
  open(@Body(new ZodValidationPipe(openCashSessionSchema)) body: OpenCashSessionInput): Promise<CashSessionView> {
    return this.sessions.open(body);
  }

  @Get('sessions/:id')
  @RequirePermission('cashier:cash_session:read')
  get(@Param('id', UuidPipe) id: string): Promise<CashSessionView> {
    return this.sessions.get(id);
  }

  @Post('sessions/:id/close')
  @HttpCode(200)
  @RequirePermission('cashier:cash_session:create')
  close(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(closeCashSessionSchema)) body: CloseCashSessionInput): Promise<CashSessionView> {
    return this.sessions.close(id, body);
  }

  /** Clôture contradictoire par un tiers habilité (jamais l'ouvreur). */
  @Post('sessions/:id/force-close')
  @HttpCode(200)
  @RequirePermission('cashier:cash_session:validate')
  forceClose(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(forceCloseCashSessionSchema)) body: ForceCloseCashSessionInput): Promise<CashSessionView> {
    return this.sessions.forceClose(id, body);
  }

  @Post('sessions/:id/validate')
  @HttpCode(200)
  @RequirePermission('cashier:cash_session:validate')
  validate(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(validateCashSessionSchema)) body: ValidateCashSessionInput): Promise<CashSessionView> {
    return this.sessions.validate(id, body);
  }
}
