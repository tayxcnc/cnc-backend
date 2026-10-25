import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StaffRole } from '../../generated/cnc-client';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ReportPeriodQuery } from '../common/dto/report-period.query';
import { SalesReportQuery } from './dto/reports.request';
import {
  MaintenanceReportResponse,
  PaymentsReportResponse,
  SalesReportResponse,
  StockMovementsReportResponse,
  TransfersReportResponse,
  VendorSpendReportResponse,
  WasteReportResponse,
} from './dto/reports.response';
import { ReportsService } from './reports.service';

const BAD_RANGE = {
  status: 400,
  description: 'A bad date, a range over 366 days, or a bad page.',
  type: ApiErrorResponse,
} as const;
const UNSIGNED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;
const ROLE_REFUSED = {
  status: 403,
  description: '"Your current staff role cannot perform this action."',
  type: ApiErrorResponse,
} as const;

/**
 * Reports (plan §5.4, §6.1, §10; card C8-1), beside the Kitchen Crosscheck
 * and Cash Reconciliation (C4). Who reads which follows the staff app's
 * Reports screen: managers read all nine; the Cashier reads Payments
 * Received, Cash Reconciliation and Daily Transfers only (`@Roles(CASHIER)`
 * is "R(Cashier)": the Cashier and managers). Every other role is refused
 * every report.
 *
 * Each takes `from` and `to` as Lagos business dates (today when absent,
 * at most 366 days) and pages its table; the figures beside the table
 * cover the whole range.
 */
@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @Roles()
  @ApiOperation({
    operationId: 'staffReportSales',
    summary: 'Sales',
    description:
      'Bills settled in the range, by the Lagos date they were settled, ' +
      'oldest first; departments by each line’s department (web drinks ' +
      'are the Bar’s); by item and by category; Still Owed; delivery fees ' +
      'as their own line (Q21). Managers only.',
  })
  @ApiResponse({ status: 200, type: SalesReportResponse })
  @ApiResponse({
    ...BAD_RANGE,
    description: `${BAD_RANGE.description} "Choose a department." for an unknown department.`,
  })
  @ApiResponse(UNSIGNED)
  @ApiResponse(ROLE_REFUSED)
  sales(@Query() query: SalesReportQuery): Promise<SalesReportResponse> {
    return this.reports.sales(query);
  }

  @Get('payments')
  @Roles(StaffRole.CASHIER)
  @ApiOperation({
    operationId: 'staffReportPayments',
    summary: 'Payments Received',
    description:
      'Every non-reversed payment dated in the range, part payments ' +
      'included, newest first, with its kind (PART_PAYMENT, ' +
      'ONLINE_CHECKOUT, FINAL_PAYMENT) and PAY- number; refunds are ' +
      'negative. The Cashier and managers.',
  })
  @ApiResponse({ status: 200, type: PaymentsReportResponse })
  @ApiResponse(BAD_RANGE)
  @ApiResponse(UNSIGNED)
  @ApiResponse(ROLE_REFUSED)
  payments(@Query() query: ReportPeriodQuery): Promise<PaymentsReportResponse> {
    return this.reports.payments(query);
  }

  @Get('transfers')
  @Roles(StaffRole.CASHIER)
  @ApiOperation({
    operationId: 'staffReportTransfers',
    summary: 'Daily Transfers',
    description:
      'Non-reversed Transfer payments dated in the range, oldest first, ' +
      'with the PAY- number, sender and reference. The Cashier and ' +
      'managers.',
  })
  @ApiResponse({ status: 200, type: TransfersReportResponse })
  @ApiResponse(BAD_RANGE)
  @ApiResponse(UNSIGNED)
  @ApiResponse(ROLE_REFUSED)
  transfers(
    @Query() query: ReportPeriodQuery,
  ): Promise<TransfersReportResponse> {
    return this.reports.transfers(query);
  }

  @Get('stock-movements')
  @Roles()
  @ApiOperation({
    operationId: 'staffReportStockMovements',
    summary: 'Stock Movements',
    description:
      'Every stock movement made in the range (by its Jos day), newest ' +
      'first. Managers only.',
  })
  @ApiResponse({ status: 200, type: StockMovementsReportResponse })
  @ApiResponse(BAD_RANGE)
  @ApiResponse(UNSIGNED)
  @ApiResponse(ROLE_REFUSED)
  stockMovements(
    @Query() query: ReportPeriodQuery,
  ): Promise<StockMovementsReportResponse> {
    return this.reports.stockMovements(query);
  }

  @Get('waste')
  @Roles()
  @ApiOperation({
    operationId: 'staffReportWaste',
    summary: 'Waste',
    description:
      'Waste logged in the range (by its Jos day), oldest first, every ' +
      'location and status. Managers only.',
  })
  @ApiResponse({ status: 200, type: WasteReportResponse })
  @ApiResponse(BAD_RANGE)
  @ApiResponse(UNSIGNED)
  @ApiResponse(ROLE_REFUSED)
  waste(@Query() query: ReportPeriodQuery): Promise<WasteReportResponse> {
    return this.reports.waste(query);
  }

  @Get('maintenance')
  @Roles()
  @ApiOperation({
    operationId: 'staffReportMaintenance',
    summary: 'Maintenance History',
    description:
      'Repairs reported in the range, oldest first, with who handled ' +
      'them and what they cost. Managers only.',
  })
  @ApiResponse({ status: 200, type: MaintenanceReportResponse })
  @ApiResponse(BAD_RANGE)
  @ApiResponse(UNSIGNED)
  @ApiResponse(ROLE_REFUSED)
  maintenance(
    @Query() query: ReportPeriodQuery,
  ): Promise<MaintenanceReportResponse> {
    return this.reports.maintenance(query);
  }

  @Get('vendor-spend')
  @Roles()
  @ApiOperation({
    operationId: 'staffReportVendorSpend',
    summary: 'Vendor Spend',
    description:
      'Every vendor with its received purchases (Fulfilled requisitions ' +
      'raised in the range, by line vendor) and its repair costs (repairs ' +
      'reported in the range). Managers only.',
  })
  @ApiResponse({ status: 200, type: VendorSpendReportResponse })
  @ApiResponse(BAD_RANGE)
  @ApiResponse(UNSIGNED)
  @ApiResponse(ROLE_REFUSED)
  vendorSpend(
    @Query() query: ReportPeriodQuery,
  ): Promise<VendorSpendReportResponse> {
    return this.reports.vendorSpend(query);
  }
}
