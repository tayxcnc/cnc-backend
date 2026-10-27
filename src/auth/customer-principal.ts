/**
 * The signed-in customer as `CncCustomerGuard` read them from the database
 * on this request. Live, never from the token: the token carries only the
 * customer's id, so a customer whose row is gone is refused at once.
 */
export interface CustomerPrincipal {
  /** Customer.id: the subject of every customer route. */
  id: string;
  memberNo: string;
}

/** The request property the guard writes the principal to. */
export const CUSTOMER_PRINCIPAL_KEY = 'cncCustomer';

/** A request as `CncCustomerGuard` leaves it. */
export interface CustomerRequest {
  [CUSTOMER_PRINCIPAL_KEY]?: CustomerPrincipal;
}
