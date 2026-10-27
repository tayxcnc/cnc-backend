import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, ValidateIf } from 'class-validator';
import { Department } from '../../../generated/cnc-client';
import { ReportPeriodQuery } from '../../common/dto/report-period.query';
import { isSent } from '../../common/is-sent';
import { DEPARTMENT_MESSAGE } from '../../orders/order-messages';

/**
 * `GET /staff/reports/sales`: the period, and the demo's Department choice
 * ("All Departments" is the field left out).
 */
export class SalesReportQuery extends ReportPeriodQuery {
  @ApiPropertyOptional({
    enum: Department,
    enumName: 'Department',
    description:
      'One department, by each line’s department (web drinks are the ' +
      'Bar’s); every department when absent.',
  })
  @ValidateIf(isSent)
  @IsEnum(Department, { message: DEPARTMENT_MESSAGE })
  department?: Department;
}
