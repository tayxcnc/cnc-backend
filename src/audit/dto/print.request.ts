import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';
import { Checked, requiredText, wholeNumber } from '../../common/checked';
import { parseIsoDate } from '../../common/calendar-date';
import { isSent } from '../../common/is-sent';
import { trimText } from '../../common/trim-text';
import {
  PRINT_DOCUMENT_MESSAGE,
  PRINT_DOCUMENTS,
  PRINT_PERIOD_MESSAGE,
  PRINT_REF_MAX_LENGTH,
  PRINT_REF_MESSAGE,
  PRINT_REVISION_MESSAGE,
  type PrintDocument,
} from '../print-documents';

/** An attendance print's period, both dates inclusive. */
export interface PrintPeriod {
  from: string;
  to: string;
}

/** Two real calendar dates, `from` not after `to`. */
function periodProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return PRINT_PERIOD_MESSAGE;

  const { from, to } = value as Record<string, unknown>;

  if (typeof from !== 'string' || typeof to !== 'string') {
    return PRINT_PERIOD_MESSAGE;
  }

  const start = parseIsoDate(from);
  const end = parseIsoDate(to);

  return start === null || end === null || start > end
    ? PRINT_PERIOD_MESSAGE
    : null;
}

/** Body of `POST /staff/audit/print`: the demo's audit-only `print`. */
export class PrintRequest {
  @ApiProperty({ enum: PRINT_DOCUMENTS, example: 'receipt' })
  @Checked((value) =>
    typeof value === 'string' &&
    (PRINT_DOCUMENTS as readonly string[]).includes(value)
      ? null
      : PRINT_DOCUMENT_MESSAGE,
  )
  document!: PrintDocument;

  @ApiProperty({
    example: 'CNCR-000001',
    maxLength: PRINT_REF_MAX_LENGTH,
    description:
      'The record printed, as its history is filed: an order number, a ' +
      'docket ref, a purchase number, a staff id, or a report title.',
  })
  @Transform(({ value }) => trimText(value))
  @Checked(
    requiredText(
      PRINT_REF_MESSAGE,
      PRINT_REF_MAX_LENGTH,
      `ref must be ${PRINT_REF_MAX_LENGTH} characters or fewer.`,
    ),
  )
  ref!: string;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'The docket revision printed, for a docket.',
  })
  @ValidateIf(isSent)
  @Checked(wholeNumber(1, PRINT_REVISION_MESSAGE))
  revision?: number;

  @ApiPropertyOptional({
    example: { from: '2026-10-01', to: '2026-10-31' },
    description: 'The period of an attendance print; ignored otherwise.',
  })
  @ValidateIf(isSent)
  @Checked(periodProblem)
  period?: PrintPeriod;
}
