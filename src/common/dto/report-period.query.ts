import { ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import { calendarDate, Checked } from '../checked';
import { isSent } from '../is-sent';
import { PaginationQuery } from './pagination.query';

/**
 * The query every report under `staff/reports` takes (plan §5.4, §10):
 * `from` and `to` as business dates, and a page. The range rules are
 * `reportPeriod` (`src/common/report-period.ts`). One class, so the nine
 * reports cannot drift apart in what a date is.
 */
export class ReportPeriodQuery extends PaginationQuery {
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
