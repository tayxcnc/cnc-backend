import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PrintRequest } from './dto/print.request';
import { PrintService } from './print.service';

/**
 * `POST /staff/audit/print` (plan §5.3): every Print button records an
 * audit-only `print`. No `@Roles`: the demo lets every staff role print
 * (`domain.ts` `print` names every non-manager role, and managers always
 * pass).
 */
@ApiTags('Activity History')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/audit')
export class PrintController {
  constructor(private readonly prints: PrintService) {}

  @Post('print')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'staffAuditPrint',
    summary: 'Record a print (print)',
    description:
      'Printing happens in the browser from data the API serves; this ' +
      'records which document was printed, of which record. Nothing else ' +
      'changes.',
  })
  @ApiResponse({ status: 204, description: 'Recorded.' })
  @ApiResponse({
    status: 400,
    description:
      '"Choose a document to print.", "Name the record printed.", "Enter a ' +
      'valid docket revision." or "Enter a valid print period."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'No bearer token, or one that fails verification.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'A customer token, a deactivated account, or a pending password change.',
    type: ApiErrorResponse,
  })
  async print(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: PrintRequest,
    @Req() httpRequest: Request,
  ): Promise<void> {
    await this.prints.record(actor, request, clientAddressOf(httpRequest));
  }
}
