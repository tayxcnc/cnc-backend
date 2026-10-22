import { ApiProperty } from '@nestjs/swagger';
import { POSITIVE_STOCK_LINES, ValidLines } from '../../common/command-lines';
import { MAPPING_PORTION_MESSAGE } from '../stock-messages';

/** One expected portion in a comparison rule. */
export class KitchenMappingLineRequest {
  @ApiProperty({ description: 'StockItem.id of a Kitchen item.' })
  stockItemId!: string;

  @ApiProperty({ minimum: 1, example: 1 })
  qty!: number;
}

/**
 * Body of `PUT /staff/kitchen-mappings/:menuItemId`: `mapping.save`, which
 * replaces the dish's whole rule ("Add or Replace a Portion Mapping").
 */
export class SaveKitchenMappingRequest {
  @ApiProperty({
    type: KitchenMappingLineRequest,
    isArray: true,
    description:
      'At least one Kitchen item, each once, in whole portions above zero.',
  })
  @ValidLines({ ...POSITIVE_STOCK_LINES, idMessage: MAPPING_PORTION_MESSAGE })
  lines!: KitchenMappingLineRequest[];
}

export class KitchenMappingLineResponse {
  @ApiProperty() stockItemId!: string;
  @ApiProperty() stockItemName!: string;
  @ApiProperty() qty!: number;
}

/** A Restaurant dish's comparison rule. */
export class KitchenMappingResponse {
  @ApiProperty() menuItemId!: string;
  @ApiProperty() menuItemSlug!: string;
  @ApiProperty() menuItemName!: string;
  @ApiProperty({ type: KitchenMappingLineResponse, isArray: true })
  lines!: KitchenMappingLineResponse[];
}

export class KitchenMappingPageResponse {
  @ApiProperty({ type: KitchenMappingResponse, isArray: true })
  data!: KitchenMappingResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}
