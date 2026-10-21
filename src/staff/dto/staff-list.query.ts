import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { trimText } from '../../common/trim-text';

/** `GET /staff/people?q=`: the Staff & Access search (plan §5.4). */
export class StaffListQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description:
      'Matches part of the name, the email or the staff number, ignoring ' +
      'case.',
    example: 'grace',
  })
  @IsOptional()
  @Transform(({ value }) => trimText(value))
  @IsString({ message: 'q must be text.' })
  @MaxLength(100, { message: 'q must be 100 characters or fewer.' })
  q?: string;
}
