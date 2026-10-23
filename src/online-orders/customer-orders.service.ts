import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Fulfilment,
  PaymentMethod,
  type Prisma,
} from '../../generated/cnc-client';
import { readPickupAddressText } from '../common/delivery-address';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import { orderTotals } from '../orders/order-totals';
import { cardText } from '../payments/paystack-transaction';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type {
  CustomerOrderPageResponse,
  CustomerOrderResponse,
} from './dto/customer-order.response';
import { CUSTOMER_ORDER_NOT_FOUND_MESSAGE } from './online-order-messages';
import { modeFulfilment, modeZone } from './online-order-rules';

type OnlineRow = Prisma.OnlineOrderGetPayload<object>;

/**
 * The signed-in customer's web orders (plan §5.2, card C7-6): `GET
 * /me/orders` and `GET /me/orders/:number`, the account app's
 * `listOrders`, `getOrder` and the order tracker, which polls the stored
 * status every 30 s (C7-9).
 *
 * Only orders linked to the customer (`OnlineOrder.customerId`, set when
 * the payment wrote the order, plan §7.4 step 4) are theirs; any other
 * number answers 404 with the app's sentence, so the route cannot tell
 * whether another customer's order exists. The order is read as it now
 * stands: a manager's edit changes its lines and sums, a zone change its
 * address and fee.
 */
@Injectable()
export class CustomerOrdersService {
  constructor(private readonly prisma: CncPrismaService) {}

  async list(
    customerId: string,
    query: PaginationQuery,
  ): Promise<CustomerOrderPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where = { customerId };
    const rows = await this.prisma.onlineOrder.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const total = await this.prisma.onlineOrder.count({ where });
    const data: CustomerOrderResponse[] = [];

    for (const row of rows) data.push(await this.view(row));

    return { data, page, pageSize, total };
  }

  async one(
    customerId: string,
    number: string,
  ): Promise<CustomerOrderResponse> {
    const order = await this.prisma.order.findUnique({
      where: { number },
      select: { id: true },
    });
    const online =
      order === null
        ? null
        : await this.prisma.onlineOrder.findFirst({
            where: { orderId: order.id, customerId },
          });

    if (online === null) {
      throw new NotFoundException(CUSTOMER_ORDER_NOT_FOUND_MESSAGE);
    }

    return this.view(online);
  }

  /** One order as the account app reads it. Queries awaited in turn. */
  private async view(online: OnlineRow): Promise<CustomerOrderResponse> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: online.orderId },
    });
    const lines = await this.prisma.orderLine.findMany({
      where: { orderId: order.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: lines.map((line) => line.menuItemId) } },
      select: { id: true, slug: true },
    });
    const slugs = new Map(items.map((item) => [item.id, item.slug]));
    const paid = await this.prisma.payment.findFirst({
      where: {
        orderId: order.id,
        method: PaymentMethod.ONLINE,
        amountKobo: { gt: 0 },
      },
      orderBy: { createdAt: 'asc' },
      select: { cardBrand: true, cardLast4: true },
    });
    const totals = orderTotals({ ...order, lines });
    const fulfilment = modeFulfilment(online.mode);

    return {
      number: order.number,
      onlineNumber: online.number,
      createdAt: online.createdAt.toISOString(),
      status: online.fulfilmentStatus,
      fulfilment,
      zone: modeZone(online.mode),
      address:
        fulfilment === Fulfilment.PICKUP
          ? await readPickupAddressText(this.prisma)
          : online.addressText,
      timing: online.timingText,
      scheduledFor: online.scheduledFor?.toISOString() ?? null,
      lines: lines.map((line) => ({
        dishId: slugs.get(line.menuItemId) ?? line.menuItemId,
        name: line.name,
        option: line.option,
        qty: line.qty,
        unitKobo: line.unitPriceKobo,
      })),
      sums: {
        subtotalKobo: totals.subtotalKobo,
        vatKobo: totals.vatKobo,
        deliveryKobo: online.feeKobo,
        totalKobo: totals.totalKobo + online.feeKobo,
      },
      card: paid === null ? null : cardText(paid.cardBrand, paid.cardLast4),
    };
  }
}
