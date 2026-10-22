import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { EnquiryKind, type Prisma } from '../../generated/cnc-client';
import { TOO_MANY_ATTEMPTS_MESSAGE } from '../auth/auth-throttle';
import { parseIsoDate } from '../common/calendar-date';
import { hashClientAddress } from '../common/client-address';
import { watToday } from '../common/wat';
import { CncConfigService } from '../config/cnc.config';
import { customerPhone } from '../customers/profile-rules';
import type {
  ContactEnquiryMailParams,
  GroupEnquiryMailParams,
} from '../mail/mail-templates';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { PAST_DATE_MESSAGE } from '../reception/reception-messages';
import { bookingDateText } from '../reception/reservation-rules';
import type {
  ContactEnquiryRequest,
  GroupEnquiryRequest,
} from './dto/enquiry.request';
import { GROUP_VENUE_MESSAGE } from './enquiry-messages';
import {
  ENQUIRY_ADDRESS_LIMIT,
  ENQUIRY_MAIL_TTL_MS,
  ENQUIRY_WINDOW_MS,
  isHoneypotFilled,
} from './enquiry-rules';

type Tx = Prisma.TransactionClient;

/** Where an enquiry's email goes, and its queue key and expiry. */
interface MailEnvelope {
  to: string;
  dedupeKey: string;
  expiresAt: Date;
}

/**
 * The two enquiry forms (plan §5.1, D50; card C6-7): the Contact page's
 * message and the booking page's large-party callback. Q20's default:
 * **stored, then emailed to CNC (`CNC_CONTACT_EMAIL`); there is no staff
 * list.**
 *
 * - **The honeypot** (`company`): filled, the request is answered exactly
 *   as an accepted one (204) and nothing is stored, sent or logged. An
 *   error would tell a script which field to leave alone, and a log line
 *   would carry whatever it chose to send (TAY's rule).
 * - **The cap**: at most `ENQUIRY_ADDRESS_LIMIT` stored enquiries per
 *   address per hour, counted on the rows under an advisory lock on the
 *   address, so requests arriving together cannot both pass (429). The
 *   in-memory throttle on the route is the first line.
 * - **The row is written first and the email queued in the same
 *   transaction** (the outbound queue), then sent after the commit. The
 *   enquiry is the thing of value: a provider outage costs delivery time,
 *   never the customer's message, and the person who wrote is not told of
 *   CNC's mail trouble. The email's Reply-To is the sender, so CNC answers
 *   by pressing Reply.
 * - No audit row: an enquiry is not a command in the staff app's record.
 */
@Injectable()
export class EnquiriesService {
  private readonly logger = new Logger(EnquiriesService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly outbound: OutboundMessagesService,
    private readonly config: CncConfigService,
  ) {}

  /** `POST /enquiries`. */
  async contact(
    request: ContactEnquiryRequest,
    clientAddress: string,
  ): Promise<void> {
    if (isHoneypotFilled(request.company)) return;

    const params: ContactEnquiryMailParams = {
      name: request.name,
      email: request.email,
      subject: request.subject,
      message: request.message,
    };

    await this.submit(
      clientAddress,
      (tx, ipHash) =>
        tx.enquiry.create({
          data: {
            createdAt: new Date(),
            kind: EnquiryKind.CONTACT,
            name: request.name,
            email: request.email,
            subject: request.subject,
            message: request.message,
            ipHash,
          },
          select: { id: true },
        }),
      (tx, envelope) =>
        this.outbound.enqueue(tx, {
          ...envelope,
          template: 'enquiry.contact',
          params,
        }),
    );
  }

  /** `POST /group-enquiries`. */
  async group(
    request: GroupEnquiryRequest,
    clientAddress: string,
  ): Promise<void> {
    if (isHoneypotFilled(request.company)) return;

    const venue = await this.prisma.venue.findUnique({
      where: { slug: request.venue.toLowerCase() },
      select: { id: true, customerTitle: true },
    });

    if (venue === null) throw new BadRequestException(GROUP_VENUE_MESSAGE);

    const date = parseIsoDate(request.date)!;

    // A callback for a day already gone is a typo; say so while the
    // person is still on the page.
    if (date < watToday(new Date())) {
      throw new BadRequestException(PAST_DATE_MESSAGE);
    }

    const phone = customerPhone(request.phone) as string;
    const email =
      request.email === undefined || request.email === ''
        ? null
        : request.email;
    const message = request.message ?? '';
    const params: GroupEnquiryMailParams = {
      name: request.name,
      phone,
      email,
      venue: venue.customerTitle,
      date: bookingDateText(date),
      guests: request.guests,
      message,
    };

    await this.submit(
      clientAddress,
      (tx, ipHash) =>
        tx.enquiry.create({
          data: {
            createdAt: new Date(),
            kind: EnquiryKind.GROUP,
            name: request.name,
            email,
            phone,
            // The form's message is optional; the column is not.
            message,
            venueId: venue.id,
            requestedDate: date,
            guests: request.guests,
            ipHash,
          },
          select: { id: true },
        }),
      (tx, envelope) =>
        this.outbound.enqueue(tx, {
          ...envelope,
          template: 'enquiry.group',
          params,
        }),
    );
  }

  /**
   * The cap, the row and the email, in one transaction; the send after
   * the commit. Never fails the request over mail.
   */
  private async submit(
    clientAddress: string,
    create: (tx: Tx, ipHash: string) => Promise<{ id: string }>,
    queue: (tx: Tx, envelope: MailEnvelope) => Promise<string>,
  ): Promise<void> {
    const ipHash = hashClientAddress(clientAddress);
    const to = this.config.contactEmail;

    const { id, messageId } = await this.prisma.$transaction(async (tx) => {
      // One address at a time, so requests arriving together cannot each
      // count the others' rows as not there yet (seen failing without it).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cnc:enquiry:${ipHash}`}))`;

      // Counted against the creation times this service wrote, on its own
      // clock (A11).
      const recent = await tx.enquiry.count({
        where: {
          ipHash,
          createdAt: { gt: new Date(Date.now() - ENQUIRY_WINDOW_MS) },
        },
      });

      if (recent >= ENQUIRY_ADDRESS_LIMIT) {
        throw new HttpException(
          TOO_MANY_ATTEMPTS_MESSAGE,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const row = await create(tx, ipHash);

      if (to === undefined) return { id: row.id, messageId: null };

      const queued = await queue(tx, {
        to,
        dedupeKey: `enquiry:${row.id}`,
        expiresAt: new Date(Date.now() + ENQUIRY_MAIL_TTL_MS),
      });

      return { id: row.id, messageId: queued };
    });

    if (messageId === null) {
      // Production refuses to boot without the inbox; locally it may be
      // unset. The enquiry is stored either way. The line names the row,
      // never what the person wrote.
      this.logger.error(
        `Enquiry ${id} was stored but not emailed: CNC_CONTACT_EMAIL is not set.`,
      );
      return;
    }

    await this.outbound.dispatch(messageId);
  }
}
