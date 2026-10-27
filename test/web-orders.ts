import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Department } from '../generated/cnc-client';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { fakePaystack } from './fake-paystack-client';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';

/**
 * Paid and held web checkouts, as the push suites need them (C10): a
 * checkout through `POST /checkouts`, reported by a signed fake
 * `charge.success`, settled before these return. On a database with the
 * real seeds, for the menu.
 */

/** The seeded dish every web order here buys: online, no choice, priced. */
export function webDish(prisma: CncPrismaService) {
  return prisma.menuItem.findFirstOrThrow({
    where: {
      active: true,
      showOnline: true,
      department: Department.RESTAURANT,
      choiceOptions: { isEmpty: true },
      priceKobo: { gt: 0 },
    },
    orderBy: { slug: 'asc' },
  });
}

/** A delivery in Jos, for `placePaidWebOrder`'s `over`. */
export const JOS_DELIVERY = {
  fulfilment: 'DELIVERY',
  address: {
    zone: 'JOS',
    street: '12 Rayfield Road',
    area: 'Rayfield',
    town: 'Jos',
    landmark: 'Opposite the filling station',
  },
};

/**
 * A checkout of two of `dishSlug`, picked up unless `over` says otherwise,
 * not yet paid. Opened inside ordering hours; it may be reported later.
 */
export async function openWebCheckout(
  app: INestApplication<App>,
  dishSlug: string,
  headers: Record<string, string> = {},
  over: Record<string, unknown> = {},
): Promise<{ reference: string; totalKobo: number }> {
  const created = (
    await request(app.getHttpServer())
      .post('/api/v1/checkouts')
      .set('Idempotency-Key', randomUUID())
      .set(headers)
      .send({
        lines: [{ dishId: dishSlug, qty: 2 }],
        fulfilment: 'PICKUP',
        timing: 'ASAP',
        name: 'Ada Okafor',
        phone: '0803 123 4567',
        email: `ada-${randomUUID()}@example.com`,
        ...over,
      })
      .expect(201)
  ).body as { reference: string; sums: { totalKobo: number } };

  return { reference: created.reference, totalKobo: created.sums.totalKobo };
}

/** Report the checkout paid, signed, and wait for the settle. */
async function reportPaid(
  app: INestApplication<App>,
  paystackKey: string,
  checkout: { reference: string; totalKobo: number },
): Promise<void> {
  await postSignedWebhook(
    app,
    chargeSuccessBody(checkout.reference, checkout.totalKobo),
    paystackKey,
  ).expect(200);
  await app.get(WebhookDispatcherService, { strict: false }).settled();
}

/**
 * A paid web order; `headers` signs a customer in. Answers the online
 * order's id and its bill's number.
 */
export async function placePaidWebOrder(
  app: INestApplication<App>,
  paystackKey: string,
  dishSlug: string,
  headers: Record<string, string> = {},
  over: Record<string, unknown> = {},
): Promise<{ id: string; number: string; reference: string }> {
  const checkout = await openWebCheckout(app, dishSlug, headers, over);

  await reportPaid(app, paystackKey, checkout);

  const online = await app.get(CncPrismaService).onlineOrder.findUniqueOrThrow({
    where: { paystackReference: checkout.reference },
    include: { order: { select: { number: true } } },
  });

  return {
    id: online.id,
    number: online.order.number,
    reference: checkout.reference,
  };
}

/**
 * Hold an open checkout `NEEDS_ATTENTION`: Paystack's verify answers twice
 * the total, so the amount check refuses the reported payment. Answers
 * the checkout's id.
 */
export async function holdWebCheckout(
  app: INestApplication<App>,
  paystackKey: string,
  checkout: { reference: string; totalKobo: number },
): Promise<string> {
  fakePaystack(app).verifyAnswers.set(checkout.reference, {
    amountKobo: checkout.totalKobo * 2,
  });
  await reportPaid(app, paystackKey, checkout);

  return (
    await app.get(CncPrismaService).checkout.findUniqueOrThrow({
      where: { reference: checkout.reference, status: 'NEEDS_ATTENTION' },
      select: { id: true },
    })
  ).id;
}
