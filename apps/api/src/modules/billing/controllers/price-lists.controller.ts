import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createPriceListItemSchema,
  createPriceListSchema,
  listPriceListItemsSchema,
  updatePriceListItemSchema,
  updatePriceListSchema,
  type CreatePriceListInput,
  type CreatePriceListItemInput,
  type ListPriceListItemsInput,
  type PriceListItemView,
  type PriceListView,
  type UpdatePriceListInput,
  type UpdatePriceListItemInput,
} from '@ghmt/shared';
import { RequirePermission } from '../../../common/decorators/auth.decorators';
import type { Page } from '../../../common/pagination/page';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { PriceListsService } from '../services/price-lists.service';

/** Grille tarifaire (docs/09 §C2) : `billing:price_list:read|update`. */
@Controller('billing')
export class PriceListsController {
  constructor(private readonly priceLists: PriceListsService) {}

  @Get('price-lists')
  @RequirePermission('billing:price_list:read')
  list(): Promise<PriceListView[]> {
    return this.priceLists.list();
  }

  @Post('price-lists')
  @RequirePermission('billing:price_list:update')
  create(@Body(new ZodValidationPipe(createPriceListSchema)) body: CreatePriceListInput): Promise<PriceListView> {
    return this.priceLists.create(body);
  }

  @Patch('price-lists/:id')
  @RequirePermission('billing:price_list:update')
  update(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(updatePriceListSchema)) body: UpdatePriceListInput): Promise<PriceListView> {
    return this.priceLists.update(id, body);
  }

  @Get('price-lists/:id/items')
  @RequirePermission('billing:price_list:read')
  listItems(@Param('id', UuidPipe) id: string, @Query(new ZodValidationPipe(listPriceListItemsSchema)) query: ListPriceListItemsInput): Promise<Page<PriceListItemView>> {
    return this.priceLists.listItems(id, query);
  }

  @Post('price-lists/:id/items')
  @RequirePermission('billing:price_list:update')
  createItem(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(createPriceListItemSchema)) body: CreatePriceListItemInput): Promise<PriceListItemView> {
    return this.priceLists.createItem(id, body);
  }

  @Patch('price-list-items/:id')
  @RequirePermission('billing:price_list:update')
  updateItem(@Param('id', UuidPipe) id: string, @Body(new ZodValidationPipe(updatePriceListItemSchema)) body: UpdatePriceListItemInput): Promise<PriceListItemView> {
    return this.priceLists.updateItem(id, body);
  }
}
