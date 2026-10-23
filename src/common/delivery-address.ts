import { AddressZone } from '../../generated/cnc-client';

/**
 * A delivery address: the zone and the four lines the website's checkout
 * and the account's Your Details both collect (plan §4.2, D53). One module,
 * so the profile (`PATCH /me`, C6-3) and checkout (`POST /checkouts`, C7)
 * agree on what an address is and answer its gaps in the same words.
 */

/** A delivery address as it is stored, every line trimmed. */
export interface DeliveryAddress {
  zone: AddressZone;
  street: string;
  area: string;
  town: string;
  landmark: string;
}

/** The four text lines, in the order the screens ask for them. */
export const ADDRESS_LINES = ['street', 'area', 'town', 'landmark'] as const;

/**
 * A missing or unknown zone (400): the checkout's sentence
 * (`components/order/OrderApp.tsx`).
 */
export const DELIVERY_ZONE_MESSAGE = 'Choose where we are delivering to.';

/**
 * A missing landmark (400): the checkout's sentence. D53: the profile
 * requires the landmark checkout requires, so a saved address can be used
 * at checkout as it stands.
 */
export const DELIVERY_LANDMARK_MESSAGE =
  'Add a nearby landmark so our rider can find you, for example a church, school or filling station.';

/** The longest address line kept. */
export const ADDRESS_LINE_MAX_LENGTH = 120;

/**
 * An address line longer than `ADDRESS_LINE_MAX_LENGTH` (400). New: the
 * screens set no length.
 */
export const ADDRESS_LINE_TOO_LONG_MESSAGE = `Keep each part of the address to ${ADDRESS_LINE_MAX_LENGTH} characters.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function line(value: Record<string, unknown>, key: string): string {
  const text = value[key];

  return typeof text === 'string' ? text.trim() : '';
}

/** Whether `value` names a delivery zone (`JOS` or `PLATEAU`). */
export function isAddressZone(value: unknown): value is AddressZone {
  return (
    typeof value === 'string' &&
    (Object.values(AddressZone) as string[]).includes(value)
  );
}

/**
 * What is wrong with a sent address, or null, in the screens' order: the
 * zone, then the street, area and town (`linesMessage`, which each caller
 * words as its screen does), then the landmark, then any line's length.
 * Only the five named keys are read.
 */
export function deliveryAddressProblem(
  value: unknown,
  linesMessage: string,
): string | null {
  if (!isRecord(value) || !isAddressZone(value.zone)) {
    return DELIVERY_ZONE_MESSAGE;
  }

  if (
    line(value, 'street') === '' ||
    line(value, 'area') === '' ||
    line(value, 'town') === ''
  ) {
    return linesMessage;
  }

  if (line(value, 'landmark') === '') return DELIVERY_LANDMARK_MESSAGE;

  return ADDRESS_LINES.some(
    (key) => line(value, key).length > ADDRESS_LINE_MAX_LENGTH,
  )
    ? ADDRESS_LINE_TOO_LONG_MESSAGE
    : null;
}

/**
 * A sent address as it is stored: the zone and the four lines trimmed.
 * Call only on a value `deliveryAddressProblem` passed.
 */
export function toDeliveryAddress(value: unknown): DeliveryAddress {
  if (!isRecord(value) || !isAddressZone(value.zone)) {
    throw new Error(
      'toDeliveryAddress was handed an address deliveryAddressProblem ' +
        'refuses. Validate it first.',
    );
  }

  return {
    zone: value.zone,
    street: line(value, 'street'),
    area: line(value, 'area'),
    town: line(value, 'town'),
    landmark: line(value, 'landmark'),
  };
}

/** Stored address lines, any of which a deleted account has cleared (Q36). */
export interface StoredAddressLines {
  addressStreet: string | null;
  addressArea: string | null;
  addressTown: string | null;
  addressLandmark: string | null;
}

/**
 * A delivery address as one line, as the website's done screen writes it
 * (`addressText`): the street, area and town, then "Landmark: …", empty
 * parts left out. The confirmation page (C7-1) and the online order's
 * display text (C7-3) both write it here, so the customer and the rider
 * read one address the same way.
 */
export function deliveryAddressText(address: StoredAddressLines): string {
  return [
    address.addressStreet,
    address.addressArea,
    address.addressTown,
    address.addressLandmark && `Landmark: ${address.addressLandmark}`,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(', ');
}
