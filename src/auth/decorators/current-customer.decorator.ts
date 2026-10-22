import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  CUSTOMER_PRINCIPAL_KEY,
  type CustomerPrincipal,
  type CustomerRequest,
} from '../customer-principal';

/**
 * The signed-in customer, as `CncCustomerGuard` read them on this request.
 *
 * Only meaningful behind `CncCustomerGuard`; without it there is no
 * principal, which is a wiring mistake, so it fails loudly as a 500 rather
 * than handing a handler `undefined`.
 */
export const CurrentCustomer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CustomerPrincipal => {
    const request = context.switchToHttp().getRequest<CustomerRequest>();
    const principal = request[CUSTOMER_PRINCIPAL_KEY];

    if (principal === undefined) {
      throw new InternalServerErrorException();
    }

    return principal;
  },
);

/**
 * The signed-in customer behind `OptionalCustomerGuard`, or null for a
 * guest with no token.
 */
export const MaybeCustomer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CustomerPrincipal | null =>
    context.switchToHttp().getRequest<CustomerRequest>()[
      CUSTOMER_PRINCIPAL_KEY
    ] ?? null,
);
