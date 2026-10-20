import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/** The 400 for a missing or malformed `version`. */
export const VERSION_FIELD_MESSAGE =
  'version must be a whole number of 0 or more.';

/**
 * The `version` every write to a versioned row names (A8).
 *
 * A request DTO for such a write extends this class, so the field is spelt,
 * validated and documented once. The value is the `version` the client read
 * with the record; `claimVersion` compares it with the row's in the same
 * statement that takes the row, and a stale one is a `409`.
 *
 * Required, not optional: a write that names no version would have nothing
 * to be stale against, and would silently overwrite the change it never saw.
 */
export class VersionedWriteDto {
  @ApiProperty({
    description:
      'The `version` of the record as the client last read it. A write ' +
      'naming an older version is refused with 409 "This record changed. ' +
      'Refresh and try again."',
    example: 3,
    minimum: 0,
  })
  @IsInt({ message: VERSION_FIELD_MESSAGE })
  @Min(0, { message: VERSION_FIELD_MESSAGE })
  version!: number;
}
