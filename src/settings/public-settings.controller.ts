import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PublicCache } from '../common/public-cache';
import { OpeningHoursResponse } from './dto/opening-hours.dto';
import { PublicBusinessResponse } from './dto/settings.response';
import { OpeningHoursService } from './opening-hours.service';
import { SettingsService } from './settings.service';

/**
 * The public reads of the business and its week (plan §5.1, C6-4):
 * `GET /business` (the header, footer, Contact page, map pin and
 * receipts) and `GET /opening-hours` (the entrance's open or closed state,
 * the footer, Contact, Reservation and the home page's Visit block).
 *
 * No sign-in, cached for a minute (`PublicCache`), and nothing internal:
 * no row ids, versions, settings or staff.
 */
@ApiTags('Public')
@Controller()
export class PublicSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly hours: OpeningHoursService,
  ) {}

  @Get('business')
  @PublicCache()
  @ApiOperation({
    operationId: 'getBusiness',
    summary: 'CNC’s business details',
    description:
      'Name, address, phone (digits only; each screen formats it), email, ' +
      'registration, map pin and social links. Public; cached for a minute.',
  })
  @ApiResponse({ status: 200, type: PublicBusinessResponse })
  business(): Promise<PublicBusinessResponse> {
    return this.settings.readPublicBusiness();
  }

  @Get('opening-hours')
  @PublicCache()
  @ApiOperation({
    operationId: 'getOpeningHours',
    summary: 'CNC’s weekly opening hours',
    description:
      'TAY’s shape: seven days, 0 = Sunday, in minutes from midnight in ' +
      'Jos; `isSet` false (and `days` null) only for a damaged table. ' +
      'Public; cached for a minute.',
  })
  @ApiResponse({ status: 200, type: OpeningHoursResponse })
  openingHours(): Promise<OpeningHoursResponse> {
    return this.hours.read();
  }
}
