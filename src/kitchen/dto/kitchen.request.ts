import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import { REASON_MAX_LENGTH } from '../../common/admin-reason';
import { calendarDate, Checked, wholeNumber } from '../../common/checked';
import { POSITIVE_STOCK_LINES, ValidLines } from '../../common/command-lines';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VERSION_FIELD_MESSAGE } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import {
  KITCHEN_DATE_MESSAGE,
  KITCHEN_LINES_MESSAGE,
  KITCHEN_PORTION_MESSAGE,
  KITCHEN_REVISION_ASSIGNED_MESSAGE,
} from '../kitchen-messages';

/** Longest order number accepted in a kitchen entry; new (the demo has none). */
const ORDER_NUMBER_MAX_LENGTH = 40;

/** One portion line of a kitchen entry. */
export class KitchenLineRequest {
  @ApiProperty({ description: 'StockItem.id of a Kitchen item.' })
  stockItemId!: string;

  @ApiProperty({ minimum: 1, example: 2 })
  qty!: number;
}

/**
 * Body of `PUT /staff/kitchen/entries/:docketRef`: `kitchen.save`, the
 * portions the kitchen used for one docket.
 *
 * With no `version` it records the docket's first entry; with one, it
 * corrects the existing entry (A8). The order, revision and date come from
 * the docket. A manager may date the entry otherwise, with a reason;
 * `revision` and `orderNumber` exist so a client that sends them is told
 * they are the system's, as the demo tells it.
 */
export class SaveKitchenEntryRequest {
  @ApiProperty({
    type: KitchenLineRequest,
    isArray: true,
    description:
      'The portions used: Kitchen items, each once, in whole numbers above ' +
      'zero. Empty only to clear an existing entry (a cancelled docket).',
  })
  @ValidLines({
    ...POSITIVE_STOCK_LINES,
    emptyMessage: KITCHEN_LINES_MESSAGE,
    idMessage: KITCHEN_PORTION_MESSAGE,
    allowEmpty: true,
  })
  lines!: KitchenLineRequest[];

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'The entry’s `version` as last read; required to correct an ' +
      'existing entry, absent for the docket’s first entry.',
  })
  @ValidateIf(isSent)
  @Checked(wholeNumber(0, VERSION_FIELD_MESSAGE))
  version?: number;

  @ApiPropertyOptional({
    example: '2026-10-21',
    description:
      'Managers only: the kitchen date (YYYY-MM-DD), when it is not the ' +
      'docket’s. Anyone else may send only the docket’s own date.',
  })
  @ValidateIf(isSent)
  @Checked(calendarDate(KITCHEN_DATE_MESSAGE))
  date?: string;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Assigned by the system: the docket’s latest revision.',
  })
  @ValidateIf(isSent)
  @Checked(wholeNumber(1, KITCHEN_REVISION_ASSIGNED_MESSAGE))
  revision?: number;

  @ApiPropertyOptional({
    example: 'CNCR-000001',
    description: 'Assigned by the system: the docket’s order number.',
  })
  @OptionalText('orderNumber', ORDER_NUMBER_MAX_LENGTH)
  orderNumber?: string;

  @ApiPropertyOptional({
    maxLength: REASON_MAX_LENGTH,
    description:
      'Required for a manager’s correction: an entry for another date, a ' +
      'closed day, or an earlier day’s entry.',
  })
  @OptionalText('reason', REASON_MAX_LENGTH)
  reason?: string;
}

/** `GET /staff/kitchen/entries`: one kitchen date's entries. */
export class KitchenEntriesQuery extends PaginationQuery {
  @ApiPropertyOptional({
    example: '2026-10-21',
    description: 'The kitchen date (YYYY-MM-DD); today in Jos when absent.',
  })
  @ValidateIf(isSent)
  @Checked(calendarDate('date must be a real calendar date (YYYY-MM-DD).'))
  date?: string;

  @ApiPropertyOptional({
    description: 'Part of a docket ref or an order number, any case.',
  })
  @OptionalText('q', 100)
  q?: string;
}

/** `GET /staff/reports/kitchen-crosscheck`: dockets by business date. */
export class KitchenCrosscheckQuery extends PaginationQuery {
  @ApiPropertyOptional({
    example: '2026-10-21',
    description: 'First business date (YYYY-MM-DD); `to` when absent.',
  })
  @ValidateIf(isSent)
  @Checked(calendarDate('from must be a real calendar date.'))
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-21',
    description: 'Last business date (YYYY-MM-DD); today in Jos when absent.',
  })
  @ValidateIf(isSent)
  @Checked(calendarDate('to must be a real calendar date.'))
  to?: string;
}
