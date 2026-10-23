import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PublicCache } from '../common/public-cache';
import {
  AvailabilityQuery,
  PublicVenuesResponse,
  VenueAvailabilityResponse,
} from './dto/public-venues.dto';
import { PublicVenuesService } from './public-venues.service';

/**
 * The booking page's public reads (plan §5.1, C6-4). No sign-in. The rooms
 * change only when staff change them and are cached for a minute; the
 * availability is never stored, because a cached "available" is a table
 * someone has just booked (gate steps 3 and 4: within one refresh).
 */
@ApiTags('Public')
@Controller('venues')
export class PublicVenuesController {
  constructor(private readonly venues: PublicVenuesService) {}

  @Get()
  @PublicCache()
  @ApiOperation({
    operationId: 'getVenues',
    summary: 'The rooms and their tables',
    description:
      'Dining and the Lounge with the tables in use: code, name, kind and ' +
      'places, and the party size that goes to the team instead. Public; ' +
      'cached for a minute.',
  })
  @ApiResponse({ status: 200, type: PublicVenuesResponse })
  list(): Promise<PublicVenuesResponse> {
    return this.venues.venues();
  }

  @Get(':venue/availability')
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'venue', description: 'Venue.slug.', example: 'dining' })
  @ApiOperation({
    operationId: 'getVenueAvailability',
    summary: 'A room’s floor plan for a date',
    description:
      'Each table as AVAILABLE, RESERVED, OCCUPIED or BLOCKED (plan §7.5), ' +
      'and the arrival times a booking may name that date. Public; never ' +
      'cached.',
  })
  @ApiResponse({ status: 200, type: VenueAvailabilityResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter a valid reservation date." or "Choose today or a later date."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description: '"Venue not found."',
    type: ApiErrorResponse,
  })
  availability(
    @Param('venue') venue: string,
    @Query() query: AvailabilityQuery,
  ): Promise<VenueAvailabilityResponse> {
    return this.venues.availability(venue, query.date);
  }
}
