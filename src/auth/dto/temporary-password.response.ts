import { ApiProperty } from '@nestjs/swagger';

/**
 * Body of `POST /api/v1/staff/people/:id/reset-password`.
 *
 * The one place a password leaves this service; TAY emails the same value
 * instead. It is shown once to the manager who reset the account, who hands
 * it over in person (`generateTemporaryPassword` says why). It is never
 * stored in plain text, logged or written to an audit row, and the holder
 * must replace it at first sign-in.
 */
export class TemporaryPasswordResponse {
  @ApiProperty({
    description:
      'The new temporary password. Show it once and do not keep it: it ' +
      'cannot be read again, and the account must change it at first ' +
      'sign-in.',
    example: '3f9a-07c2-b6d1-0e44-9a7c',
    format: 'password',
  })
  temporaryPassword!: string;
}
