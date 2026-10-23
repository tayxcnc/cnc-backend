import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AddressZone,
  CheckoutSource,
  CheckoutStatus,
  Department,
  Fulfilment,
  type Prisma,
  StockLocation,
} from '../../generated/cnc-client';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { hashClientAddress } from '../common/client-address';
import { toDeliveryAddress } from '../common/delivery-address';
import { CncConfigService } from '../config/cnc.config';
import { customerPhone } from '../customers/profile-rules';
import {
  PAYSTACK_CLIENT,
  type PaystackClient,
  PaystackUnavailableError,
} from '../payments/paystack-client';
import {
  PAYMENT_PROVIDER_UNREACHABLE_MESSAGE,
  PAYMENT_START_FAILED_MESSAGE,
} from '../payments/payment-messages';
import { cardText } from '../payments/paystack-transaction';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { OpeningHoursService } from '../settings/opening-hours.service';
import {
  type CartLineInput,
  type CartSums,
  type PricedLine,
  type PricingMenuItem,
  cartSlugs,
  cartSums,
  priceCart,
} from './cart-pricing';
import {
  CHECKOUT_NOT_FOUND_MESSAGE,
  shortDrinkWarning,
} from './checkout-messages';
import { judgeTiming } from './checkout-timing';
import type {
  CheckoutCreatedResponse,
  CheckoutRequest,
  CheckoutStatusResponse,
  PricedLineResponse,
  QuoteRequest,
  QuoteResponse,
} from './dto/checkout.dto';
import type { OrderingTimeSettings } from './ordering-times';

type Tx = Prisma.TransactionClient;
type Reader = Pick<
  Tx,
  'settings' | 'menuItem' | 'stockItem' | 'stockBalance' | 'openingHoursDay'
>;

/**
 * How long a checkout waits for its payment before the checkouts sweep
 * (C7-5) asks Paystack about it and, unpaid, marks it `EXPIRED`. Half an
 * hour: long enough for a bank's one-time code and a second card, short
 * enough that a timing chosen at checkout still means something.
 */
export const CHECKOUT_TTL_MS = 30 * 60 * 1000;

/** The prefix of every reference CNC sends Paystack. */
export const CHECKOUT_REFERENCE_PREFIX = 'cnc-order-';

/** What `create` stores with the idempotent answer (no Paystack fields). */
export type CreatedCheckout = Omit<
  CheckoutCreatedResponse,
  'accessCode' | 'authorizationUrl'
>;

/** A priced cart and its money, before anything is stored. */
interface PricedCart {
  lines: PricedLine[];
  vatBps: number;
  sums: CartSums;
  warnings: string[];
  settings: OrderingTimeSettings;
}

const TIMING_AND_MONEY = {
  vatBps: true,
  deliveryJosKobo: true,
  deliveryOutsideKobo: true,
  lastOrderSlotMinutes: true,
  slotStepMinutes: true,
  leadPickupMinutes: true,
  leadJosMinutes: true,
  leadOutsideMinutes: true,
} satisfies Prisma.SettingsSelect;

/** A stored line as a response shows it. */
function lineResponse(line: PricedLine): PricedLineResponse {
  return {
    dishId: line.dishId,
    name: line.name,
    option: line.option,
    qty: line.qty,
    unitKobo: line.unitPriceKobo,
  };
}

/** `Checkout.lines` read back, checked rather than cast. */
function storedLines(value: Prisma.JsonValue): PricedLine[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return [];
    }

    const line = entry as Record<string, unknown>;

    return typeof line.menuItemId === 'string' &&
      typeof line.dishId === 'string' &&
      typeof line.name === 'string' &&
      typeof line.option === 'string' &&
      typeof line.qty === 'number' &&
      typeof line.unitPriceKobo === 'number' &&
      (line.department === Department.RESTAURANT ||
        line.department === Department.BAR)
      ? [
          {
            menuItemId: line.menuItemId,
            dishId: line.dishId,
            name: line.name,
            option: line.option,
            qty: line.qty,
            unitPriceKobo: line.unitPriceKobo,
            department: line.department,
          },
        ]
      : [];
  });
}

/**
 * The web checkout (plan §5.1, §7.4 steps 1 and 2; card C7-1):
 *
 * - `quote`: `POST /ordering/quote`, the server's prices for a cart;
 * - `create`: `POST /checkouts`, inside the idempotency service's
 *   transaction: prices the cart, judges the timing, writes the `PENDING`
 *   checkout. **No order number is drawn**: that happens only when the
 *   payment is confirmed (C7-3), so an abandoned checkout burns none;
 * - `startPayment`: after that transaction commits, Paystack's initialize
 *   for the checkout's reference and exact total, stored once on the row,
 *   so a retry with the same key answers the same payment page;
 * - `read`: `GET /checkouts/:reference`, the confirmation page.
 */
@Injectable()
export class CheckoutsService {
  private readonly logger = new Logger(CheckoutsService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly hours: OpeningHoursService,
    private readonly config: CncConfigService,
    @Inject(PAYSTACK_CLIENT) private readonly paystack: PaystackClient,
  ) {}

  /** `POST /ordering/quote`. */
  async quote(request: QuoteRequest): Promise<QuoteResponse> {
    const priced = await this.price(
      this.prisma,
      request.lines,
      request.fulfilment,
      request.fulfilment === Fulfilment.DELIVERY
        ? (request.zone ?? null)
        : null,
    );

    return {
      lines: priced.lines.map(lineResponse),
      vatBps: priced.vatBps,
      sums: priced.sums,
      warnings: priced.warnings,
    };
  }

  /** `POST /checkouts`, in the idempotent command's transaction. */
  async create(
    tx: Tx,
    customer: CustomerPrincipal | null,
    request: CheckoutRequest,
    ipAddress: string,
  ): Promise<CreatedCheckout> {
    const now = new Date();
    const address =
      request.fulfilment === Fulfilment.DELIVERY
        ? toDeliveryAddress(request.address)
        : null;
    const zone = address?.zone ?? null;
    const priced = await this.price(
      tx,
      request.lines,
      request.fulfilment,
      zone,
    );
    const { days } = await this.hours.read(tx);
    const timing = judgeTiming({
      request,
      now,
      settings: priced.settings,
      days,
      fulfilment: request.fulfilment,
      zone,
    });

    if ('problem' in timing) throw new BadRequestException(timing.problem);

    const reference = `${CHECKOUT_REFERENCE_PREFIX}${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS);

    await tx.checkout.create({
      data: {
        reference,
        customerId: customer?.id ?? null,
        source: customer === null ? CheckoutSource.WEB : CheckoutSource.APP,
        expiresAt,
        lines: priced.lines as unknown as Prisma.InputJsonValue,
        subtotalKobo: priced.sums.subtotalKobo,
        vatKobo: priced.sums.vatKobo,
        deliveryKobo: priced.sums.deliveryKobo,
        totalKobo: priced.sums.totalKobo,
        vatBps: priced.vatBps,
        fulfilment: request.fulfilment,
        zone,
        addressStreet: address?.street ?? null,
        addressArea: address?.area ?? null,
        addressTown: address?.town ?? null,
        addressLandmark: address?.landmark ?? null,
        contactName: request.name,
        contactPhone: customerPhone(request.phone)!,
        contactEmail: request.email,
        note: request.note ?? '',
        saveDetails: request.saveDetails ?? false,
        timing: timing.timing,
        timingText: timing.timingText,
        scheduledFor: timing.scheduledFor,
        ipHash: hashClientAddress(ipAddress),
      },
      select: { id: true },
    });

    return {
      reference,
      expiresAt: expiresAt.toISOString(),
      lines: priced.lines.map(lineResponse),
      vatBps: priced.vatBps,
      sums: priced.sums,
      warnings: priced.warnings,
    };
  }

  /**
   * Paystack's payment page for a committed checkout, initialized once.
   *
   * Already initialized: the stored page, so a retry answers the same one.
   * Otherwise Paystack's initialize with the checkout's reference, its
   * email and **exactly its total in kobo**, and the page stored only if
   * no other request stored one first. Paystack unreachable: 503, the
   * checkout waits and the same key tries again. Paystack refusing (a bad
   * email, a reference it has seen): 502, and the checkout is closed
   * `FAILED`, so the page asks for a new checkout.
   */
  async startPayment(
    reference: string,
  ): Promise<{ accessCode: string; authorizationUrl: string }> {
    const checkout = await this.prisma.checkout.findUniqueOrThrow({
      where: { reference },
      select: {
        id: true,
        status: true,
        accessCode: true,
        authorizationUrl: true,
        totalKobo: true,
        contactEmail: true,
        source: true,
      },
    });

    if (checkout.accessCode !== null && checkout.authorizationUrl !== null) {
      return {
        accessCode: checkout.accessCode,
        authorizationUrl: checkout.authorizationUrl,
      };
    }

    if (checkout.status !== CheckoutStatus.PENDING) {
      throw new BadGatewayException(PAYMENT_START_FAILED_MESSAGE);
    }

    let started: { accessCode: string; authorizationUrl: string };

    try {
      started = await this.paystack.initialize({
        email: checkout.contactEmail,
        amountKobo: checkout.totalKobo,
        reference,
        callbackUrl: this.config.buildWebUrl(
          checkout.source === CheckoutSource.APP ? '/account' : '/order',
        ),
        metadata: { checkoutId: checkout.id },
      });
    } catch (error) {
      if (error instanceof PaystackUnavailableError) {
        throw new ServiceUnavailableException(
          PAYMENT_PROVIDER_UNREACHABLE_MESSAGE,
        );
      }

      this.logger.error(
        `Paystack refused to start checkout ${checkout.id}; closed as failed.`,
      );
      await this.prisma.checkout.updateMany({
        where: { id: checkout.id, status: CheckoutStatus.PENDING },
        data: { status: CheckoutStatus.FAILED },
      });
      throw new BadGatewayException(PAYMENT_START_FAILED_MESSAGE);
    }

    await this.prisma.checkout.updateMany({
      where: { id: checkout.id, accessCode: null },
      data: {
        accessCode: started.accessCode,
        authorizationUrl: started.authorizationUrl,
      },
    });

    const stored = await this.prisma.checkout.findUniqueOrThrow({
      where: { id: checkout.id },
      select: { accessCode: true, authorizationUrl: true },
    });

    return {
      accessCode: stored.accessCode ?? started.accessCode,
      authorizationUrl: stored.authorizationUrl ?? started.authorizationUrl,
    };
  }

  /** `GET /checkouts/:reference`. */
  async read(reference: string): Promise<CheckoutStatusResponse> {
    const checkout = await this.prisma.checkout.findUnique({
      where: { reference },
      select: {
        reference: true,
        status: true,
        orderId: true,
        contactName: true,
        fulfilment: true,
        zone: true,
        addressStreet: true,
        addressArea: true,
        addressTown: true,
        addressLandmark: true,
        timingText: true,
        scheduledFor: true,
        lines: true,
        subtotalKobo: true,
        vatKobo: true,
        deliveryKobo: true,
        totalKobo: true,
        cardBrand: true,
        cardLast4: true,
      },
    });

    if (checkout === null) {
      throw new NotFoundException(CHECKOUT_NOT_FOUND_MESSAGE);
    }

    const order =
      checkout.orderId === null
        ? null
        : await this.prisma.order.findUnique({
            where: { id: checkout.orderId },
            select: { number: true },
          });

    return {
      reference: checkout.reference,
      status: checkout.status,
      number: order?.number ?? null,
      name: checkout.contactName,
      fulfilment: checkout.fulfilment,
      zone: checkout.zone,
      address: await this.addressText(checkout),
      timing: checkout.timingText,
      scheduledFor: checkout.scheduledFor?.toISOString() ?? null,
      lines: storedLines(checkout.lines).map(lineResponse),
      sums: {
        subtotalKobo: checkout.subtotalKobo,
        vatKobo: checkout.vatKobo,
        deliveryKobo: checkout.deliveryKobo,
        totalKobo: checkout.totalKobo,
      },
      card: cardText(checkout.cardBrand, checkout.cardLast4),
    };
  }

  /**
   * The address as the website's done screen writes it (`addressText`):
   * the delivery lines and "Landmark: …", or "Pickup at CNC, " and CNC's
   * address from the business details with ", Nigeria", as the site
   * appends it.
   */
  private async addressText(checkout: {
    fulfilment: Fulfilment;
    addressStreet: string | null;
    addressArea: string | null;
    addressTown: string | null;
    addressLandmark: string | null;
  }): Promise<string> {
    if (checkout.fulfilment === Fulfilment.PICKUP) {
      const business = await this.prisma.business.findUnique({
        where: { singleton: true },
        select: { addressLine: true },
      });

      return business === null
        ? 'Pickup at CNC'
        : `Pickup at CNC, ${business.addressLine}, Nigeria`;
    }

    return [
      checkout.addressStreet,
      checkout.addressArea,
      checkout.addressTown,
      checkout.addressLandmark && `Landmark: ${checkout.addressLandmark}`,
    ]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(', ');
  }

  /**
   * Price a cart: the menu as it stands, the settings' VAT and the zone's
   * fee (pickup free), and a warning for each drink the Bar holds fewer
   * of than the cart asks for. Queries awaited in turn, never nested: it
   * also runs inside the checkout's transaction (*Data and migrations*).
   */
  private async price(
    reader: Reader,
    lines: CartLineInput[],
    fulfilment: Fulfilment,
    zone: AddressZone | null,
  ): Promise<PricedCart> {
    const settings = await reader.settings.findUniqueOrThrow({
      where: { singleton: true },
      select: TIMING_AND_MONEY,
    });
    const items = await reader.menuItem.findMany({
      where: { slug: { in: cartSlugs(lines) } },
      select: {
        id: true,
        slug: true,
        name: true,
        priceKobo: true,
        department: true,
        active: true,
        showOnline: true,
        choiceOptions: true,
      },
    });
    const bySlug = new Map<string, PricingMenuItem>(
      items.map((item) => [item.slug, item]),
    );
    const priced = priceCart(lines, bySlug);

    if ('problem' in priced) throw new BadRequestException(priced.problem);

    const deliveryKobo =
      fulfilment === Fulfilment.PICKUP
        ? 0
        : zone === AddressZone.PLATEAU
          ? settings.deliveryOutsideKobo
          : settings.deliveryJosKobo;

    return {
      lines: priced.lines,
      vatBps: settings.vatBps,
      sums: cartSums(priced.lines, settings.vatBps, deliveryKobo),
      warnings: await this.shortDrinks(reader, priced.lines),
      settings,
    };
  }

  /**
   * The warning for each drink whose paired Bar stock is below the cart's
   * quantity of it (plan §7.4: warn, never refuse). A missing balance row
   * is a zero balance.
   */
  private async shortDrinks(
    reader: Reader,
    lines: PricedLine[],
  ): Promise<string[]> {
    const wanted = new Map<string, { name: string; qty: number }>();

    for (const line of lines) {
      if (line.department !== Department.BAR) continue;

      const entry = wanted.get(line.menuItemId);

      wanted.set(line.menuItemId, {
        name: line.name,
        qty: (entry?.qty ?? 0) + line.qty,
      });
    }

    if (wanted.size === 0) return [];

    const stock = await reader.stockItem.findMany({
      where: { menuItemId: { in: [...wanted.keys()] } },
      select: { id: true, menuItemId: true },
    });
    const balances = await reader.stockBalance.findMany({
      where: {
        stockItemId: { in: stock.map((item) => item.id) },
        location: StockLocation.BAR,
      },
      select: { stockItemId: true, qty: true },
    });
    const held = new Map<string, number>();

    for (const item of stock) {
      const balance = balances.find((row) => row.stockItemId === item.id);

      if (item.menuItemId !== null)
        held.set(item.menuItemId, balance?.qty ?? 0);
    }

    return [...wanted.entries()]
      .filter(([menuItemId, want]) => (held.get(menuItemId) ?? 0) < want.qty)
      .map(([, want]) => shortDrinkWarning(want.name));
  }
}
