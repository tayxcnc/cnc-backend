import { ApiProperty } from '@nestjs/swagger';
import {
  Department,
  Fulfilment,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
} from '../../../generated/cnc-client';

/** One dish on a docket, as the kitchen reads it. */
export class DocketItemResponse {
  @ApiProperty() menuItemId!: string;
  @ApiProperty({ example: 'Pancakes' }) name!: string;
  @ApiProperty({
    description: '`""` when the dish has no choice.',
    example: 'Suya beef',
  })
  option!: string;
  @ApiProperty({ example: 2 }) qty!: number;
  @ApiProperty({ example: 750000 }) unitPriceKobo!: number;
}

/**
 * A kitchen docket revision (plan §4.3): `KOT-<order number>`, the full
 * list of the order's confirmed Restaurant lines at that revision. A
 * cancellation docket has no items.
 */
export class DocketResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'KOT-CNCR-000001' }) ref!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ example: 'CNCR-000001' }) orderNumber!: string;
  @ApiProperty({ example: 1 }) revision!: number;
  @ApiProperty({
    description: 'The order’s business date (YYYY-MM-DD), not the print date.',
    example: '2026-10-21',
  })
  businessDate!: string;
  @ApiProperty({ type: DocketItemResponse, isArray: true })
  items!: DocketItemResponse[];
  @ApiProperty({
    description: 'The order notes when this revision was written.',
  })
  notes!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null for a web docket.',
  })
  staffId!: string | null;
  @ApiProperty({ type: String, nullable: true }) staffName!: string | null;
  @ApiProperty({ enum: OrderChannel, enumName: 'OrderChannel' })
  channel!: OrderChannel;
  @ApiProperty({
    enum: Fulfilment,
    enumName: 'Fulfilment',
    nullable: true,
    description: 'A web docket’s delivery or pickup.',
  })
  fulfilment!: Fulfilment | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A web pre-order’s time.',
  })
  scheduledFor!: string | null;
  @ApiProperty({ description: 'When the revision was written.' })
  createdAt!: string;
  @ApiProperty({ description: 'True for a cancellation docket (no items).' })
  cancellation!: boolean;
}

/** `GET /staff/dockets`. */
export class DocketPageResponse {
  @ApiProperty({ type: DocketResponse, isArray: true }) data!: DocketResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/** One line of a bill. */
export class OrderLineResponse {
  @ApiProperty() id!: string;
  @ApiProperty() menuItemId!: string;
  @ApiProperty({ description: 'The dish’s name when the line was added.' })
  name!: string;
  @ApiProperty({ description: '`""` when the dish has no choice.' })
  option!: string;
  @ApiProperty({ example: 2 }) qty!: number;
  @ApiProperty({
    description: 'The price when the line was added.',
    example: 750000,
  })
  unitPriceKobo!: number;
  @ApiProperty({ example: 1500000 }) lineTotalKobo!: number;
  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;
}

/** A bill's figures (the demo's `totals()` and `paidSoFar`). */
export class OrderTotalsResponse {
  @ApiProperty() subtotalKobo!: number;
  @ApiProperty({
    description: 'The discount applied, never above the subtotal.',
  })
  discountKobo!: number;
  @ApiProperty() serviceKobo!: number;
  @ApiProperty() vatKobo!: number;
  @ApiProperty() totalKobo!: number;
  @ApiProperty({ description: 'The total less reservation credit used.' })
  dueKobo!: number;
  @ApiProperty({
    description: 'Money received so far, reversed payments excluded.',
  })
  paidKobo!: number;
  @ApiProperty({ description: 'Still owed; 0 once settled or cancelled.' })
  balanceKobo!: number;
}

/** A payment against the bill, for the receipt and the history. */
export class OrderPaymentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'PAY-000001' }) number!: string;
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty({ description: 'Negative for a refund.' }) amountKobo!: number;
  @ApiProperty() sender!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ description: 'A part payment.' }) part!: boolean;
  @ApiProperty() reversed!: boolean;
  @ApiProperty({ type: String, nullable: true }) staffName!: string | null;
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty() createdAt!: string;
}

/** Deposit credit a checked-in booking at this table still holds (D38). */
export class ReservationCreditResponse {
  @ApiProperty() reservationId!: string;
  @ApiProperty({ example: 'RSV-000001' }) number!: string;
  @ApiProperty() name!: string;
  @ApiProperty() availableKobo!: number;
}

/** The table a bill is on. */
export class OrderTableResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'B1' }) code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: 'dining' }) venueSlug!: string;
  @ApiProperty({ example: 'Diner' }) venueName!: string;
}

/**
 * `GET /staff/orders/:id` and every order command's answer: the bill, its
 * lines and totals, its payments, its latest docket and the `version` the
 * next write names.
 */
export class OrderResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'CNCR-000001' }) number!: string;
  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;
  @ApiProperty({ enum: OrderChannel, enumName: 'OrderChannel' })
  channel!: OrderChannel;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' })
  status!: OrderStatus;
  @ApiProperty({ type: OrderTableResponse, nullable: true })
  table!: OrderTableResponse | null;
  @ApiProperty({ example: 'B1' }) label!: string;
  @ApiProperty() guest!: string;
  @ApiProperty() notes!: string;
  @ApiProperty({
    description: 'The business date it was opened on.',
    example: '2026-10-21',
  })
  businessDate!: string;
  @ApiProperty({ description: 'The latest docket revision (0: never sent).' })
  revision!: number;
  @ApiProperty({ example: 750 }) vatBps!: number;
  @ApiProperty({ example: 0 }) serviceBps!: number;
  @ApiProperty({ description: 'The discount set by a manager.' })
  discountKobo!: number;
  @ApiProperty({ description: 'Reservation credit used at settlement.' })
  depositKobo!: number;
  @ApiProperty({ type: String, nullable: true }) reservationId!: string | null;
  @ApiProperty({ type: String, nullable: true }) openedById!: string | null;
  @ApiProperty({ type: String, nullable: true }) openedByName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) settledAt!: string | null;
  @ApiProperty({
    description: 'Open and opened today: lines and details may change.',
  })
  editable!: boolean;
  @ApiProperty({
    description:
      'A Restaurant bill whose lines differ from its latest docket: confirm ' +
      'before taking payment.',
  })
  unsentChanges!: boolean;
  @ApiProperty({ description: 'Something has been paid already.' })
  partPaid!: boolean;
  @ApiProperty({ type: OrderLineResponse, isArray: true })
  lines!: OrderLineResponse[];
  @ApiProperty({ type: OrderTotalsResponse }) totals!: OrderTotalsResponse;
  @ApiProperty({ type: OrderPaymentResponse, isArray: true })
  payments!: OrderPaymentResponse[];
  @ApiProperty({ type: DocketResponse, nullable: true })
  latestDocket!: DocketResponse | null;
  @ApiProperty({ type: ReservationCreditResponse, isArray: true })
  reservationCredits!: ReservationCreditResponse[];
  @ApiProperty({ example: 0 }) version!: number;
}

/** `POST /staff/orders/:id/confirm`. */
export class OrderConfirmResponse {
  @ApiProperty({
    description:
      'True when nothing had changed since the latest docket: it is ' +
      'returned to print again and no revision was written.',
  })
  reprint!: boolean;
  @ApiProperty({ type: DocketResponse }) docket!: DocketResponse;
  @ApiProperty({ type: OrderResponse }) order!: OrderResponse;
}

/**
 * `POST /staff/orders/:id/cancel`: the cancelled bill and, for a Restaurant
 * bill the kitchen had been sent, the cancellation docket to print (a new
 * revision with no items).
 */
export class OrderCancelResponse {
  @ApiProperty({
    type: DocketResponse,
    nullable: true,
    description:
      'The cancellation docket, or null when no docket was ever sent ' +
      '(a Bar bill, or a Restaurant bill never confirmed).',
  })
  docket!: DocketResponse | null;
  @ApiProperty({ type: OrderResponse }) order!: OrderResponse;
}

/** One bill in the till's list. */
export class OrderSummaryResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'CNCB-000001' }) number!: string;
  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;
  @ApiProperty({ enum: OrderChannel, enumName: 'OrderChannel' })
  channel!: OrderChannel;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' })
  status!: OrderStatus;
  @ApiProperty({ type: String, nullable: true }) tableId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'B1' })
  tableCode!: string | null;
  @ApiProperty() label!: string;
  @ApiProperty() guest!: string;
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty({ description: 'How many lines the bill has.' })
  lineCount!: number;
  @ApiProperty() totalKobo!: number;
  @ApiProperty() paidKobo!: number;
  @ApiProperty() balanceKobo!: number;
  @ApiProperty() partPaid!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
}

/** How many active bills each filter chip holds (the demo's chip counts). */
export class OrderFilterCountsResponse {
  @ApiProperty() all!: number;
  @ApiProperty() unsettled!: number;
  @ApiProperty() awaitingPayment!: number;
  @ApiProperty() partPaid!: number;
  @ApiProperty() previousDays!: number;
}

/** `GET /staff/orders`. */
export class OrderPageResponse {
  @ApiProperty({ type: OrderSummaryResponse, isArray: true })
  data!: OrderSummaryResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({
    type: OrderFilterCountsResponse,
    description:
      'The department’s active (open or awaiting payment) bills per chip, ' +
      'whatever the query’s own filters.',
  })
  counts!: OrderFilterCountsResponse;
}
