import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  VERSION_FIELD_MESSAGE,
  VersionedWriteDto,
} from './versioned-write.dto';

function errorsFor(body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(VersionedWriteDto, body)).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
}

describe('VersionedWriteDto', () => {
  it.each([0, 1, 42])('accepts version %p', (version) => {
    expect(errorsFor({ version })).toEqual([]);
  });

  it.each([
    ['missing', {}],
    ['null', { version: null }],
    ['negative', { version: -1 }],
    ['fractional', { version: 1.5 }],
    ['a string', { version: '3' }],
  ])('refuses a version that is %s', (_label, body) => {
    const errors = errorsFor(body);

    expect(errors.length).toBeGreaterThan(0);
    expect(new Set(errors)).toEqual(new Set([VERSION_FIELD_MESSAGE]));
  });
});
