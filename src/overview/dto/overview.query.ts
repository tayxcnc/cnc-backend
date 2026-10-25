import { PickType } from '@nestjs/swagger';
import { ReportPeriodQuery } from '../../common/dto/report-period.query';

/**
 * `GET /staff/overview`: `from` and `to`, checked as every report checks
 * them (`ReportPeriodQuery`'s two fields, without the page: the overview
 * is not a list). `PickType` carries their validation.
 */
export class OverviewQuery extends PickType(ReportPeriodQuery, [
  'from',
  'to',
] as const) {}
