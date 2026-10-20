import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ISO_DATE } from '../../common/calendar-date';
import { PaginationQuery } from '../../common/dto/pagination.query';

/**
 * `GET /staff/audit` filters and page (plan §5.4, Activity History). Every
 * filter is exact. Managers and the Owner may use any of them; other roles
 * only `ref`, and Reception also `action=maintenance.save` (plan §4.8).
 */
export class AuditListQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description:
      'The module, as the rows carry it: `Point of Sale`, `Staff & Access`, ' +
      '`Menu & Prices`…',
    example: 'Menu & Prices',
  })
  @IsOptional()
  @IsString({ message: 'module must be a string.' })
  @MaxLength(64, { message: 'module must be 64 characters or fewer.' })
  module?: string;

  @ApiPropertyOptional({
    description: 'The command name, as the staff app spells it.',
    example: 'menu.save',
  })
  @IsOptional()
  @IsString({ message: 'action must be a string.' })
  @MaxLength(100, { message: 'action must be 100 characters or fewer.' })
  action?: string;

  @ApiPropertyOptional({
    description: 'Staff.id of the person who acted.',
    example: 'clx8k2p9r0000v8n4h1q2w3e4',
  })
  @IsOptional()
  @IsString({ message: 'staffId must be a string.' })
  @MaxLength(64, { message: 'staffId must be 64 characters or fewer.' })
  staffId?: string;

  @ApiPropertyOptional({
    description:
      "The record's human reference: an order or purchase number, a `KOT-` " +
      'ref, a staff number, a menu slug. One record’s history.',
    example: 'CNCR-000012',
  })
  @IsOptional()
  @IsString({ message: 'ref must be a string.' })
  @MaxLength(100, { message: 'ref must be 100 characters or fewer.' })
  ref?: string;

  @ApiPropertyOptional({
    description: 'First WAT calendar date, inclusive.',
    example: '2026-10-01',
  })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'from must be a date in YYYY-MM-DD form.' })
  from?: string;

  @ApiPropertyOptional({
    description: 'Last WAT calendar date, inclusive.',
    example: '2026-10-21',
  })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'to must be a date in YYYY-MM-DD form.' })
  to?: string;
}
