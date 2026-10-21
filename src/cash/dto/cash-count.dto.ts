import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import { calendarDate, Checked, wholeNumber } from '../../common/checked';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { isSent } from '../../common/is-sent';
import { CASH_COUNT_MESSAGE, CASH_DATE_MESSAGE } from '../cash-messages';

/** Body of `POST /staff/cash-counts`: `cash.count`. */
export class CreateCashCountRequest {
  @ApiProperty({
    example: '2026-10-21',
    description:
      'The business date reconciled (YYYY-MM-DD): today or earlier in Jos.',
  })
  @Checked(calendarDate(CASH_DATE_MESSAGE))
  businessDate!: string;

  @ApiProperty({
    example: 4500000,
    minimum: 0,
    description: 'The cash physically counted, in kobo.',
  })
  @Checked(wholeNumber(0, CASH_COUNT_MESSAGE))
  countedKobo!: number;
}

/** A drawer count with its figures. */
export class CashCountResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'CASH-000001' }) number!: string;
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty() staffId!: string;
  @ApiProperty() staffName!: string;
  @ApiProperty({
    description:
      'The date’s non-reversed cash payments when the count was recorded ' +
      '(a cash refund counts against it).',
  })
  expectedKobo!: number;
  @ApiProperty() countedKobo!: number;
  @ApiProperty({ description: 'Counted less expected: negative is short.' })
  differenceKobo!: number;
  @ApiProperty() createdAt!: string;
}

/** `GET /staff/reports/cash`: counts by business date. */
export class CashReportQuery extends PaginationQuery {
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

/** Reports → Cash Reconciliation. */
export class CashReportResponse {
  @ApiProperty({ type: CashCountResponse, isArray: true })
  data!: CashCountResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ example: '2026-10-21' }) from!: string;
  @ApiProperty({ example: '2026-10-21' }) to!: string;
  @ApiProperty({
    description:
      'Non-reversed cash payments dated in the range (Cash Received in ' +
      'Range).',
  })
  cashReceivedKobo!: number;
  @ApiProperty({
    description:
      'The difference of the range’s latest count, or 0 with none (Latest ' +
      'Variance).',
  })
  latestDifferenceKobo!: number;
}
