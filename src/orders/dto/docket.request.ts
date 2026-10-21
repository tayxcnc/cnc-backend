import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, ValidateIf } from 'class-validator';
import { OrderChannel } from '../../../generated/cnc-client';
import { calendarDate, Checked } from '../../common/checked';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { isSent } from '../../common/is-sent';

/** `GET /staff/dockets`: one business date's dockets, latest revision each. */
export class DocketListQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description: 'The business date (YYYY-MM-DD); today in Jos when absent.',
    example: '2026-10-21',
  })
  @ValidateIf(isSent)
  @Checked(calendarDate('date must be a real calendar date (YYYY-MM-DD).'))
  date?: string;

  @ApiPropertyOptional({
    enum: OrderChannel,
    enumName: 'OrderChannel',
    description: 'WEB for the day’s web dockets (plan §5.4, Kitchen).',
  })
  @ValidateIf(isSent)
  @IsEnum(OrderChannel, { message: 'channel must be POS or WEB.' })
  channel?: OrderChannel;
}
