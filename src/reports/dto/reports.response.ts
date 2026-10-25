import { ApiProperty } from '@nestjs/swagger';
import {
  Department,
  OrderChannel,
  PaymentMethod,
} from '../../../generated/cnc-client';
import { RepairResponse } from '../../assets/dto/assets.response';
import { StockMovementResponse } from '../../stock/dto/stock.response';
import { WasteResponse } from '../../waste/dto/waste.response';

/**
 * The Payments Received report's Kind column (the demo's words: Part
 * Payment, Online Checkout, Final Payment), travelling `UPPER_SNAKE` (A5).
 */
export enum PaymentKind {
  PART_PAYMENT = 'PART_PAYMENT',
  ONLINE_CHECKOUT = 'ONLINE_CHECKOUT',
  FINAL_PAYMENT = 'FINAL_PAYMENT',
}

/** What every report page carries besides its rows. */
class ReportPageBase {
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ description: 'Rows in the whole range.' }) total!: number;
  @ApiProperty({ example: '2026-10-21' }) from!: string;
  @ApiProperty({ example: '2026-10-21' }) to!: string;
}

// ---------------------------------------------------------------- Sales

/** One settled bill: the demo's Sales table row. */
export class SalesOrderRowResponse {
  @ApiProperty() orderId!: string;
  @ApiProperty({ example: 'CNCR-000120' }) number!: string;
  @ApiProperty({
    enum: Department,
    enumName: 'Department',
    description: 'The bill’s own department (its number’s).',
  })
  department!: Department;
  @ApiProperty({ enum: OrderChannel, enumName: 'OrderChannel' })
  channel!: OrderChannel;
  @ApiProperty({
    enum: Department,
    enumName: 'Department',
    isArray: true,
    description: 'The departments its lines are in.',
  })
  departments!: Department[];
  @ApiProperty({
    example: '2026-10-21',
    description: 'The bill’s business date (Opened).',
  })
  openedOn!: string;
  @ApiProperty({
    example: '2026-10-21',
    description: 'The Lagos date it was settled (Settled).',
  })
  settledOn!: string;
  @ApiProperty() settledAt!: string;
  @ApiProperty({
    description:
      'Items less the discount (Net Items). With a department chosen, ' +
      'every figure is that department’s share of the bill.',
  })
  netItemsKobo!: number;
  @ApiProperty() vatKobo!: number;
  @ApiProperty() serviceKobo!: number;
  @ApiProperty({ description: 'Bill Total.' }) totalKobo!: number;
}

/** One department's settled sales (the Restaurant and Bar figures). */
export class SalesDepartmentResponse {
  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;
  @ApiProperty() totalKobo!: number;
  @ApiProperty({ description: 'Settled bills with a line in it.' })
  bills!: number;
}

/** Sales by Item. */
export class SalesItemResponse {
  @ApiProperty() menuItemId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'The dish’s staff category.' })
  category!: string;
  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;
  @ApiProperty({ description: 'Quantity Sold.' }) qty!: number;
  @ApiProperty({
    description:
      'Item Sales Before Tax: the lines at the prices sold, before ' +
      'order-level discounts.',
  })
  salesKobo!: number;
}

/** Sales by Category. */
export class SalesCategoryResponse {
  @ApiProperty() category!: string;
  @ApiProperty() qty!: number;
  @ApiProperty() salesKobo!: number;
}

/** Reports → Sales. */
export class SalesReportResponse extends ReportPageBase {
  @ApiProperty({ type: SalesOrderRowResponse, isArray: true })
  data!: SalesOrderRowResponse[];
  @ApiProperty({
    enum: Department,
    enumName: 'Department',
    nullable: true,
    description: 'The department chosen, or null for all.',
  })
  department!: Department | null;
  @ApiProperty({
    description: 'Completed Sales: the bills’ totals, VAT and service in.',
  })
  completedSalesKobo!: number;
  @ApiProperty({ description: 'Settled bills in the range.' })
  settledBills!: number;
  @ApiProperty({ type: SalesDepartmentResponse, isArray: true })
  departments!: SalesDepartmentResponse[];
  @ApiProperty({ description: 'VAT Recorded.' }) vatKobo!: number;
  @ApiProperty({ description: 'Service recorded.' }) serviceKobo!: number;
  @ApiProperty({
    description:
      'Still Owed: what open bills (Open or Payment, any date) still owe ' +
      'after part payments.',
  })
  stillOwedKobo!: number;
  @ApiProperty() openBills!: number;
  @ApiProperty({
    description:
      'Delivery fees of the web orders settled in the range (Q21: a ' +
      'separate line, never inside the sales figures), whatever the ' +
      'department chosen.',
  })
  deliveryFeesKobo!: number;
  @ApiProperty() deliveryOrders!: number;
  @ApiProperty({ type: SalesItemResponse, isArray: true })
  byItem!: SalesItemResponse[];
  @ApiProperty({ type: SalesCategoryResponse, isArray: true })
  byCategory!: SalesCategoryResponse[];
}

// ------------------------------------------------------- Payments, transfers

/** One payment received (or given back: a refund is negative). */
export class ReportPaymentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'PAY-000001' }) number!: string;
  @ApiProperty({ description: 'When it was recorded (Time).' }) at!: string;
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ example: 'CNCR-000120' }) orderNumber!: string;
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty({ enum: PaymentKind, enumName: 'PaymentKind' })
  kind!: PaymentKind;
  @ApiProperty() amountKobo!: number;
  @ApiProperty() sender!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ nullable: true, type: String }) staffId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null for a web payment nobody on the staff took.',
  })
  staffName!: string | null;
}

/** Money received through one method. */
export class PaymentMethodTotalResponse {
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty() amountKobo!: number;
  @ApiProperty() payments!: number;
}

/** Reports → Payments Received. */
export class PaymentsReportResponse extends ReportPageBase {
  @ApiProperty({ type: ReportPaymentResponse, isArray: true })
  data!: ReportPaymentResponse[];
  @ApiProperty({ description: 'Money Received.' }) receivedKobo!: number;
  @ApiProperty() payments!: number;
  @ApiProperty({ description: 'Part Payments.' }) partKobo!: number;
  @ApiProperty() partPayments!: number;
  @ApiProperty({
    type: PaymentMethodTotalResponse,
    isArray: true,
    description: 'Cash, Card, Transfer and Online, always all four.',
  })
  methods!: PaymentMethodTotalResponse[];
}

/** Reports → Daily Transfers. */
export class TransfersReportResponse extends ReportPageBase {
  @ApiProperty({ type: ReportPaymentResponse, isArray: true })
  data!: ReportPaymentResponse[];
  @ApiProperty() totalKobo!: number;
}

// ------------------------------------------- Stock, waste, maintenance, vendors

/** Reports → Stock Movements. */
export class StockMovementsReportResponse extends ReportPageBase {
  @ApiProperty({ type: StockMovementResponse, isArray: true })
  data!: StockMovementResponse[];
}

/** One waste entry, with the Lagos date it was logged. */
export class WasteReportRowResponse extends WasteResponse {
  @ApiProperty({ example: '2026-10-21', description: 'The Date column.' })
  businessDate!: string;
}

/** Reports → Waste. */
export class WasteReportResponse extends ReportPageBase {
  @ApiProperty({ type: WasteReportRowResponse, isArray: true })
  data!: WasteReportRowResponse[];
}

/** Reports → Maintenance History. */
export class MaintenanceReportResponse extends ReportPageBase {
  @ApiProperty({ type: RepairResponse, isArray: true })
  data!: RepairResponse[];
}

/** One vendor's spend. */
export class VendorSpendRowResponse {
  @ApiProperty() vendorId!: string;
  @ApiProperty() vendorName!: string;
  @ApiProperty({ description: 'Purchases Received.' })
  purchasesKobo!: number;
  @ApiProperty({ description: 'Maintenance Cost.' }) repairsKobo!: number;
  @ApiProperty() totalKobo!: number;
}

/** Reports → Vendor Spend. */
export class VendorSpendReportResponse extends ReportPageBase {
  @ApiProperty({ type: VendorSpendRowResponse, isArray: true })
  data!: VendorSpendRowResponse[];
  @ApiProperty() purchasesKobo!: number;
  @ApiProperty() repairsKobo!: number;
  @ApiProperty() totalKobo!: number;
}
