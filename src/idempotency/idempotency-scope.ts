import { hashClientAddress } from '../common/client-address';

/**
 * Whose keys a key is compared with (plan §4.8): `staff:<id>`,
 * `customer:<id>` or `anon:<address hash>`.
 *
 * A key is unique within its scope only, so one caller can never replay
 * another caller's response by sending the same UUID: a guessed or leaked key
 * would otherwise hand over somebody else's order or booking confirmation.
 * The scope comes from the authenticated subject on the server, never from
 * the request.
 */
export const idempotencyScope = {
  staff: (staffId: string): string => `staff:${staffId}`,
  customer: (customerId: string): string => `customer:${customerId}`,
  /**
   * A caller with no session (the website's checkout and booking), by the
   * address `clientAddressOf` reports, hashed (`hashClientAddress`), so the
   * table does not keep a list of addresses. Two guests behind one address
   * share a scope, which only matters if they also share a UUID.
   */
  anonymous: (clientAddress: string): string =>
    `anon:${hashClientAddress(clientAddress)}`,
};
