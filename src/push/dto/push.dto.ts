import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Checked } from '../../common/checked';
import { trimText } from '../../common/trim-text';
import { BASE64URL } from '../../config/vapid';
import { STAFF_PUSH_EVENTS, type StaffPushEvent } from '../push-catalogue';
import { PUSH_ENDPOINT_MESSAGE, pushEndpointProblem } from '../push-hosts';

/** The longest endpoint the column holds. */
export const ENDPOINT_MAX_LENGTH = 1024;

/** The longest `p256dh`, `auth` and application server key accepted. */
export const P256DH_MAX_LENGTH = 128;
export const AUTH_MAX_LENGTH = 64;
export const APPLICATION_SERVER_KEY_MAX_LENGTH = 128;

/** A subscription's keys, or the key it was made with, are not usable. */
export const PUSH_KEYS_MESSAGE =
  "This device's notification keys aren't valid.";

/** The endpoint as a request field: a known push service, at most 1024. */
function endpointProblem(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= ENDPOINT_MAX_LENGTH &&
    pushEndpointProblem(value) === null
    ? null
    : PUSH_ENDPOINT_MESSAGE;
}

/** URL-safe base64 of at most `max` characters. */
function base64Url(value: unknown, max: number): boolean {
  return (
    typeof value === 'string' && value.length <= max && BASE64URL.test(value)
  );
}

/** The browser's two encryption keys for one subscription. */
export class PushSubscriptionKeys {
  @ApiProperty({
    description: 'URL-safe base64 of 65 bytes.',
    maxLength: P256DH_MAX_LENGTH,
  })
  p256dh!: string;

  @ApiProperty({
    description: 'URL-safe base64 of 16 bytes.',
    maxLength: AUTH_MAX_LENGTH,
  })
  auth!: string;
}

/**
 * `POST /me/push/subscriptions` and `POST /staff/push/subscriptions` (C10):
 * the browser's `PushSubscription`, and the key it was made with. One
 * sentence per field (`@Checked`); `keys` is checked whole, as a plain
 * object, so a refusal reads the same whichever key is wrong.
 */
export class PushSubscribeRequest {
  @ApiProperty({
    description:
      'The push service URL for this browser: https, on a known push ' +
      'service (FCM, Mozilla, Apple, Windows).',
    maxLength: ENDPOINT_MAX_LENGTH,
  })
  @Transform(({ value }) => trimText(value))
  @Checked(endpointProblem)
  endpoint!: string;

  @ApiProperty({ type: PushSubscriptionKeys })
  @Checked((value) => {
    const keys = value as Record<string, unknown> | null;

    return typeof value === 'object' &&
      keys !== null &&
      base64Url(keys.p256dh, P256DH_MAX_LENGTH) &&
      base64Url(keys.auth, AUTH_MAX_LENGTH)
      ? null
      : PUSH_KEYS_MESSAGE;
  })
  keys!: PushSubscriptionKeys;

  @ApiProperty({
    description:
      'The application server key the subscription was made with, URL-safe ' +
      'base64, as `GET …/push/public-key` gave it. A key that is no longer ' +
      'the service’s is refused with 409, and the device subscribes again.',
    maxLength: APPLICATION_SERVER_KEY_MAX_LENGTH,
  })
  @Checked((value) =>
    base64Url(value, APPLICATION_SERVER_KEY_MAX_LENGTH)
      ? null
      : PUSH_KEYS_MESSAGE,
  )
  applicationServerKey!: string;
}

/** `DELETE /me/push/subscriptions` and `DELETE /staff/push/subscriptions`. */
export class PushUnsubscribeRequest {
  @ApiProperty({ maxLength: ENDPOINT_MAX_LENGTH })
  @Transform(({ value }) => trimText(value))
  @Checked((value) =>
    typeof value === 'string' &&
    value !== '' &&
    value.length <= ENDPOINT_MAX_LENGTH
      ? null
      : PUSH_ENDPOINT_MESSAGE,
  )
  endpoint!: string;
}

/** `GET /me/push/public-key`. */
export class PushPublicKeyResponse {
  @ApiProperty({
    description:
      'The VAPID public key, URL-safe base64 of 65 bytes: the ' +
      '`applicationServerKey` for `pushManager.subscribe`. CNC’s own key.',
  })
  publicKey!: string;
}

/** `GET /staff/push/public-key`. */
export class StaffPushPublicKeyResponse extends PushPublicKeyResponse {
  @ApiProperty({
    enum: STAFF_PUSH_EVENTS,
    enumName: 'StaffPushEvent',
    isArray: true,
    description:
      'The events the reader’s role can receive, from the role on their ' +
      'account now. Empty for a role with none (Waiter, Bartender).',
  })
  events!: StaffPushEvent[];
}
