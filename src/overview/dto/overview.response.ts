import { ApiProperty } from '@nestjs/swagger';
import {
  Department,
  OrderStatus,
  PaymentMethod,
  ReservationStatus,
  StockLocation,
  TaskStatus,
} from '../../../generated/cnc-client';
import { OVERVIEW_WIDGETS } from '../../shell/overview-preferences';
import { OverviewInterval } from '../overview-trend';

/** Needs Attention's five lines, travelling `UPPER_SNAKE` (A5). */
export enum AttentionKey {
  PURCHASES = 'PURCHASES',
  WASTE = 'WASTE',
  CROSSCHECK = 'CROSSCHECK',
  STOCK_REQUESTS = 'STOCK_REQUESTS',
  TASKS = 'TASKS',
}

export class OverviewMoneyCountResponse {
  @ApiProperty() totalKobo!: number;
  @ApiProperty({ description: 'Bills counted.' }) orders!: number;
}

export class OverviewOccupancyResponse {
  @ApiProperty({ description: 'Tables with guests seated now.' })
  occupied!: number;
  @ApiProperty({ description: 'Every active table.' }) tables!: number;
}

export class OverviewTrendPointResponse {
  @ApiProperty({ example: '2026-10-21' }) key!: string;
  @ApiProperty({ example: '21 Oct' }) name!: string;
  @ApiProperty() amountKobo!: number;
}

export class OverviewTrendResponse {
  @ApiProperty({ enum: OverviewInterval, enumName: 'OverviewInterval' })
  interval!: OverviewInterval;
  @ApiProperty({ type: [OverviewTrendPointResponse] })
  points!: OverviewTrendPointResponse[];
}

export class OverviewDepartmentResponse {
  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;
  @ApiProperty() amountKobo!: number;
}

export class OverviewMethodResponse {
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty() amountKobo!: number;
}

export class OverviewBestsellerResponse {
  @ApiProperty() menuItemId!: string;
  @ApiProperty({ description: 'The name as first sold in the range.' })
  name!: string;
  @ApiProperty() qty!: number;
}

export class OverviewVenueResponse {
  @ApiProperty() venueId!: string;
  @ApiProperty({ example: 'dining' }) slug!: string;
  @ApiProperty({ example: 'Diner' }) name!: string;
  @ApiProperty() available!: number;
  @ApiProperty() occupied!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() locked!: number;
}

export class OverviewAttentionResponse {
  @ApiProperty({ enum: AttentionKey, enumName: 'AttentionKey' })
  key!: AttentionKey;
  @ApiProperty({ example: 'Purchase Requisitions' }) label!: string;
  @ApiProperty({ example: 'approvals', description: 'The page it opens.' })
  page!: string;
  @ApiProperty() count!: number;
}

export class OverviewOpenOrderResponse {
  @ApiProperty() orderId!: string;
  @ApiProperty({ example: 'CNCR-000120' }) number!: string;
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;
  @ApiProperty({ description: 'The position (Position column).' })
  label!: string;
  @ApiProperty({
    enum: [OrderStatus.OPEN, OrderStatus.PAYMENT],
    description: 'OPEN is "Unsettled"; PAYMENT is "Awaiting Payment".',
  })
  status!: OrderStatus;
  @ApiProperty({ description: 'What it still owes.' }) balanceKobo!: number;
}

export class OverviewArrivalResponse {
  @ApiProperty() reservationId!: string;
  @ApiProperty({ example: 'RES-000001' }) number!: string;
  @ApiProperty({ example: '19:30' }) time!: string;
  @ApiProperty() name!: string;
  @ApiProperty() tableName!: string;
  @ApiProperty() party!: number;
  @ApiProperty({ enum: ReservationStatus, enumName: 'ReservationStatus' })
  status!: ReservationStatus;
}

export class OverviewLowStockRowResponse {
  @ApiProperty() stockItemId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: [StockLocation.KITCHEN, StockLocation.BAR] })
  location!: StockLocation;
  @ApiProperty({ description: 'The balance (Available).' }) qty!: number;
  @ApiProperty() unit!: string;
  @ApiProperty() minimum!: number;
}

export class OverviewLowStockResponse {
  @ApiProperty({
    type: [OverviewLowStockRowResponse],
    description: 'The eight lowest, lowest first.',
  })
  data!: OverviewLowStockRowResponse[];
  @ApiProperty({ description: 'Every item below its minimum.' })
  total!: number;
}

export class OverviewTaskRowResponse {
  @ApiProperty() taskId!: string;
  @ApiProperty({ example: 'T-000001' }) number!: string;
  @ApiProperty() title!: string;
  @ApiProperty() assignedToName!: string;
  @ApiProperty({ enum: TaskStatus, enumName: 'TaskStatus' })
  status!: TaskStatus;
}

export class OverviewTasksResponse {
  @ApiProperty({
    type: [OverviewTaskRowResponse],
    description: 'The six oldest that are not Done.',
  })
  data!: OverviewTaskRowResponse[];
  @ApiProperty({ description: 'Every task not Done.' }) total!: number;
}

/**
 * `GET /staff/overview`. A widget the reader is not shown is `null`; the
 * ids in `widgets` say which were computed.
 */
export class OverviewResponse {
  @ApiProperty({ example: '2026-10-21' }) from!: string;
  @ApiProperty({ example: '2026-10-21' }) to!: string;
  @ApiProperty({
    enum: ['FULL', 'BASIC'],
    description:
      'FULL: a manager’s layout over the range. BASIC: the staff overview, ' +
      'today only.',
  })
  scope!: 'FULL' | 'BASIC';
  @ApiProperty({ enum: OVERVIEW_WIDGETS, isArray: true })
  widgets!: string[];

  @ApiProperty({ type: OverviewMoneyCountResponse, nullable: true })
  sales!: OverviewMoneyCountResponse | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Kitchen only, in place of sales: today’s kitchen entries.',
  })
  kitchenEntries!: number | null;
  @ApiProperty({ type: OverviewMoneyCountResponse, nullable: true })
  outstanding!: OverviewMoneyCountResponse | null;
  @ApiProperty({ type: OverviewOccupancyResponse, nullable: true })
  occupancy!: OverviewOccupancyResponse | null;
  @ApiProperty({ type: Number, nullable: true })
  arrivals!: number | null;
  @ApiProperty({ type: OverviewTrendResponse, nullable: true })
  trend!: OverviewTrendResponse | null;
  @ApiProperty({ type: [OverviewDepartmentResponse], nullable: true })
  departments!: OverviewDepartmentResponse[] | null;
  @ApiProperty({ type: [OverviewMethodResponse], nullable: true })
  payments!: OverviewMethodResponse[] | null;
  @ApiProperty({ type: [OverviewBestsellerResponse], nullable: true })
  bestsellers!: OverviewBestsellerResponse[] | null;
  @ApiProperty({ type: [OverviewVenueResponse], nullable: true })
  service!: OverviewVenueResponse[] | null;
  @ApiProperty({ type: [OverviewAttentionResponse], nullable: true })
  attention!: OverviewAttentionResponse[] | null;
  @ApiProperty({ type: [OverviewOpenOrderResponse], nullable: true })
  orders!: OverviewOpenOrderResponse[] | null;
  @ApiProperty({ type: [OverviewArrivalResponse], nullable: true })
  nextArrivals!: OverviewArrivalResponse[] | null;
  @ApiProperty({ type: OverviewLowStockResponse, nullable: true })
  stock!: OverviewLowStockResponse | null;
  @ApiProperty({ type: OverviewTasksResponse, nullable: true })
  tasks!: OverviewTasksResponse | null;
}
