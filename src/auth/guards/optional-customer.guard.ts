import { type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CncCustomerGuard } from './cnc-customer.guard';

/**
 * A public route a signed-in customer may also call (plan §5.1: "P or C",
 * `POST /reservations`, C7's checkout).
 *
 * No `Authorization` header: the caller is a guest, and the route runs
 * with no principal (`@MaybeCustomer()` is null). A header: it is judged
 * exactly as `CncCustomerGuard` judges it, so an expired or forged token is
 * a 401 (the app refreshes and retries, rather than booking as a guest by
 * accident) and a staff token a 403.
 */
@Injectable()
export class OptionalCustomerGuard extends CncCustomerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (request.headers.authorization === undefined) return true;

    return super.canActivate(context);
  }
}
