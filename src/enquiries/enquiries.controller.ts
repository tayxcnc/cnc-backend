import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import {
  ContactEnquiryRequest,
  GroupEnquiryRequest,
} from './dto/enquiry.request';
import { EnquiriesService } from './enquiries.service';
import { EnquiryThrottle } from './enquiry-rules';

const ACCEPTED = {
  status: 204,
  description:
    'Received: stored and queued to CNC’s inbox. Also the answer when the ' +
    'hidden `company` field was filled, in which case nothing was kept; ' +
    'the two cannot be told apart, by design. Says nothing about whether ' +
    'the email has gone, which is not the sender’s concern.',
} as const;

const TOO_MANY = {
  status: 429,
  description:
    '"Too many attempts. Wait a few minutes and try again." Five ' +
    'enquiries per address per hour, both forms together.',
  type: ApiErrorResponse,
} as const;

/**
 * The website's two enquiry forms (plan §5.1, card C6-7). Public writes
 * that make CNC send an email, so each carries a throttle, a stored cap
 * and a honeypot (`EnquiriesService`). Q20: emailed to CNC, no staff list.
 */
@ApiTags('Public')
@Controller()
@UseGuards(ClientAddressThrottlerGuard)
export class EnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Post('enquiries')
  @HttpCode(HttpStatus.NO_CONTENT)
  @EnquiryThrottle()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'sendEnquiry',
    summary: 'Send the Contact page’s message to CNC',
    description:
      'Stores the enquiry and emails it to CNC’s inbox, with Reply-To set ' +
      'to the sender.',
  })
  @ApiResponse(ACCEPTED)
  @ApiResponse({
    status: 400,
    description:
      '"Please add your name, your email and a message.", "Please add a ' +
      'valid email address so we can reply.", "Choose what we can help ' +
      'with.", or a length sentence.',
    type: ApiErrorResponse,
  })
  @ApiResponse(TOO_MANY)
  contact(
    @Body() request: ContactEnquiryRequest,
    @Req() httpRequest: Request,
  ): Promise<void> {
    return this.enquiries.contact(request, clientAddressOf(httpRequest));
  }

  @Post('group-enquiries')
  @HttpCode(HttpStatus.NO_CONTENT)
  @EnquiryThrottle()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'sendGroupEnquiry',
    summary: 'Ask CNC to call back about a large party',
    description:
      'The booking page’s form for a party at the room’s large-party size ' +
      'or more. Stores the request and emails it to CNC’s inbox; CNC calls ' +
      'the phone given.',
  })
  @ApiResponse(ACCEPTED)
  @ApiResponse({
    status: 400,
    description:
      '"Please add your name.", "Please add a phone number we can call you ' +
      'back on, for example 0803 123 4567.", "Please add a valid email ' +
      'address, or leave it empty.", "Choose Dining or the Lounge.", "Enter ' +
      'a valid reservation date.", "Choose today or a later date.", "Please ' +
      'add the number of guests.", or a length sentence.',
    type: ApiErrorResponse,
  })
  @ApiResponse(TOO_MANY)
  group(
    @Body() request: GroupEnquiryRequest,
    @Req() httpRequest: Request,
  ): Promise<void> {
    return this.enquiries.group(request, clientAddressOf(httpRequest));
  }
}
