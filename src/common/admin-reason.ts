import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Checked, requiredText } from './checked';
import { trimText } from './trim-text';

/**
 * The demo's `admin()` refusal (`staff/lib/domain.ts`), byte for byte (A7):
 * a manager correction sent without a reason. Every "M+r" command in plan
 * §6.2 (a stock item's units, a cancel, a reopen, a reversal, a kitchen
 * correction…) answers it, so it has one home.
 */
export const ADMIN_REASON_MESSAGE = 'An admin correction requires a reason.';

/** Longest reason accepted for a correction. */
export const REASON_MAX_LENGTH = 500;

/**
 * The `reason` field of an "M+r" request: required, trimmed, not blank, at
 * most {@link REASON_MAX_LENGTH} characters, refused with
 * {@link ADMIN_REASON_MESSAGE} and nothing else. One decorator, so every
 * correction route asks for its reason the same way and documents it once.
 */
export function AdminReason(description: string): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ description, maxLength: REASON_MAX_LENGTH }),
    Transform(({ value }) => trimText(value)),
    Checked(
      requiredText(
        ADMIN_REASON_MESSAGE,
        REASON_MAX_LENGTH,
        `reason must be ${REASON_MAX_LENGTH} characters or fewer.`,
      ),
    ),
  );
}
