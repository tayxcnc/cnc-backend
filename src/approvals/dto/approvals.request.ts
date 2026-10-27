import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, ValidateIf } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { isSent } from '../../common/is-sent';
import { trimText } from '../../common/trim-text';
import { APPROVAL_VIEWS, type ApprovalView } from '../approval-rules';
import { APPROVAL_VIEW_MESSAGE } from '../approvals-messages';

/**
 * `GET /staff/approvals`. The page and page size apply to each of the two
 * lists (requisitions and waste) on its own, as the screen shows them in
 * two tables.
 */
export class ApprovalsQuery extends PaginationQuery {
  @ApiPropertyOptional({
    enum: APPROVAL_VIEWS,
    enumName: 'ApprovalView',
    description:
      'PENDING (the default): awaiting a decision, oldest first. HISTORY: ' +
      'decided, newest first.',
  })
  @ValidateIf(isSent)
  @IsIn(APPROVAL_VIEWS, { message: APPROVAL_VIEW_MESSAGE })
  view?: ApprovalView;

  @ApiPropertyOptional({
    description:
      'Part of a requisition or waste number or note, a line’s vendor name ' +
      'or a waste entry’s item name, any case.',
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}
