import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ContactChannel, type Prisma } from '../../generated/cnc-client';
import { ACCOUNT_GONE_MESSAGE } from '../auth/guards/cnc-staff.guard';
import { toDeliveryAddress } from '../common/delivery-address';
import { WELCOME_NOTIFICATION } from '../customer-notifications/customer-notification-texts';
import { CustomerNotificationsService } from '../customer-notifications/customer-notifications.service';
import { PhotoStore } from '../images/photo-store.service';
import type { UploadedImageFile } from '../images/uploaded-image';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { drawNumber } from '../prisma/sequences';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import { linkBookingsToVerifiedEmail } from '../reception/customer-link';
import { lockCustomerEmail } from './customer-email-lock';
import type { CustomerProfileResponse } from './dto/customer-profile.response';
import type { UpdateMeRequest } from './dto/update-me.request';
import {
  KEEP_A_CONTACT_MESSAGE,
  PHONE_TAKEN_MESSAGE,
  customerPhone,
  prefsRuleBroken,
  toPrefsChange,
} from './profile-rules';

/** The columns a profile is built from. */
const PROFILE_SELECT = {
  id: true,
  memberNo: true,
  name: true,
  email: true,
  phone: true,
  addressZone: true,
  addressStreet: true,
  addressArea: true,
  addressTown: true,
  addressLandmark: true,
  prefOrderUpdates: true,
  prefBookingReminders: true,
  prefOffers: true,
  prefChannel: true,
  photo: true,
  createdAt: true,
  notificationsReadAt: true,
} as const satisfies Prisma.CustomerSelect;

type ProfileRow = Prisma.CustomerGetPayload<{ select: typeof PROFILE_SELECT }>;

type Tx = Prisma.TransactionClient;

/** What a command needs of the customer it has locked. */
export interface LockedCustomer {
  id: string;
  email: string | null;
  phone: string | null;
  photo: string | null;
}

/**
 * Customers (plan §4.2): finding or creating one from a verified email, the
 * profile every session response and `GET /me` return, and the customer's
 * own changes to it (`PATCH /me`, the photo). The one place a customer
 * row is created, so the member number, the lock and the defaults are
 * decided once; checkout's "Save my details" (C7) creates through here too.
 *
 * A deleted account (Q36, `deletedAt`) is, to every method here, an
 * account that is gone: 401, as the guard answers.
 */
@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly photos: PhotoStore,
    private readonly notifications: CustomerNotificationsService,
  ) {}

  /**
   * The advisory lock every write that gives an email to a customer takes
   * first (`cnc:customer-email:<email>`): a first sign-in, an email change,
   * and (C7) checkout's "Save my details". Two of them naming one address
   * at once then run one after the other, and the second finds the first's
   * row instead of meeting the unique index as a 500.
   */
  async lockEmail(tx: Tx, email: string): Promise<void> {
    await lockCustomerEmail(tx, email);
  }

  /**
   * Lock a live customer's row for the rest of the caller's transaction
   * (`FOR UPDATE`) and read what a command checks: two of the customer's
   * own devices saving at once then run one after the other, so a rule
   * that spans two fields (keep a phone or an email) holds. 401 when the
   * row is gone or the account deleted.
   */
  async lockLive(tx: Tx, customerId: string): Promise<LockedCustomer> {
    const rows = await tx.$queryRaw<LockedCustomer[]>`
      SELECT "id", "email", "phone", "photo"
      FROM "Customer"
      WHERE "id" = ${customerId} AND "deletedAt" IS NULL
      FOR UPDATE`;

    const row = rows[0];

    if (row === undefined) {
      throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);
    }

    return row;
  }

  /**
   * The customer holding `email`, created when there is none, with the
   * email marked verified: the caller has just proved it with a code.
   *
   * Under `lockEmail`, so two first sign-ins with one address (or a
   * sign-in racing checkout's create, C7) make one customer, not a
   * unique-index 500. The member number is drawn only when a row is
   * created, so returning customers burn none. A new customer's name is
   * empty until the first-time name step saves it (the account app's
   * `isNew || !name`), and their channel is email (Q5).
   */
  async findOrCreateVerified(
    tx: Tx,
    email: string,
  ): Promise<{ id: string; isNew: boolean }> {
    await this.lockEmail(tx, email);

    const now = new Date();
    const existing = await tx.customer.findUnique({
      where: { email },
      select: { id: true, name: true, emailVerifiedAt: true },
    });

    if (existing !== null) {
      if (existing.emailVerifiedAt === null) {
        await tx.customer.update({
          where: { id: existing.id },
          data: { emailVerifiedAt: now },
        });
      }

      await linkBookingsToVerifiedEmail(tx, existing.id, email);

      return { id: existing.id, isNew: existing.name.trim() === '' };
    }

    const created = await tx.customer.create({
      data: {
        memberNo: await drawNumber(tx, 'customer'),
        name: '',
        email,
        emailVerifiedAt: now,
        prefChannel: ContactChannel.EMAIL,
      },
      select: { id: true },
    });

    // The first item in the in-app list (C6-8), as the account app's demo
    // showed it.
    await this.notifications.record(
      tx,
      created.id,
      WELCOME_NOTIFICATION,
      `customer:${created.id}:welcome`,
    );

    // A15: the guest's bookings under this email join the account only
    // now that the email is proved (C6-5).
    await linkBookingsToVerifiedEmail(tx, created.id, email);

    return { id: created.id, isNew: true };
  }

  /** The customer's profile. 401 when the row is gone or deleted. */
  async profile(customerId: string): Promise<CustomerProfileResponse> {
    const row = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: PROFILE_SELECT,
    });

    if (row === null) {
      throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);
    }

    return this.toProfile(row);
  }

  /**
   * `PATCH /me`: each field only when it is sent, in one transaction on the
   * locked row. The DTO has checked each field's shape; what depends on
   * the account (a contact left, an email for the email channel, a phone
   * another account holds) is checked here.
   */
  async update(
    customerId: string,
    request: UpdateMeRequest,
  ): Promise<CustomerProfileResponse> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await this.lockLive(tx, customerId);
        const data: Prisma.CustomerUpdateInput = {};

        if (request.name !== undefined) data.name = request.name;

        if (request.phone !== undefined) {
          const phone = customerPhone(request.phone) ?? null;

          if (phone === null && current.email === null) {
            throw new BadRequestException(KEEP_A_CONTACT_MESSAGE);
          }

          data.phone = phone;
        }

        if (request.address === null) {
          Object.assign(data, {
            addressZone: null,
            addressStreet: null,
            addressArea: null,
            addressTown: null,
            addressLandmark: null,
          } satisfies Prisma.CustomerUpdateInput);
        } else if (request.address !== undefined) {
          const address = toDeliveryAddress(request.address);

          Object.assign(data, {
            addressZone: address.zone,
            addressStreet: address.street,
            addressArea: address.area,
            addressTown: address.town,
            addressLandmark: address.landmark,
          } satisfies Prisma.CustomerUpdateInput);
        }

        if (request.prefs !== undefined) {
          const change = toPrefsChange(request.prefs);
          const broken = prefsRuleBroken(change, current.email);

          if (broken !== null) throw new BadRequestException(broken);

          if (change.orderUpdates !== undefined) {
            data.prefOrderUpdates = change.orderUpdates;
          }
          if (change.bookingReminders !== undefined) {
            data.prefBookingReminders = change.bookingReminders;
          }
          if (change.offers !== undefined) data.prefOffers = change.offers;
          if (change.channel !== undefined) data.prefChannel = change.channel;
        }

        if (Object.keys(data).length > 0) {
          await tx.customer.update({ where: { id: customerId }, data });
        }
      });
    } catch (error) {
      // `Customer.phone` is unique: the second account to save a number.
      if (uniqueViolationTargets(error).includes('phone')) {
        throw new ConflictException(PHONE_TAKEN_MESSAGE);
      }

      throw error;
    }

    return this.profile(customerId);
  }

  /**
   * `POST /me/photo`: store the upload (256 pixels square, every piece of
   * metadata removed), point the account at it, then remove the photo it
   * replaced. The order `PhotoStore` describes: the upload before the
   * transaction, the old object after the commit, the new one removed if
   * the command fails.
   */
  async replacePhoto(
    customerId: string,
    file: UploadedImageFile | undefined,
  ): Promise<CustomerProfileResponse> {
    const gsUri = await this.photos.store('customer', customerId, file);

    return this.writePhoto(customerId, gsUri);
  }

  /** `DELETE /me/photo`: the account shows no photo; the object is removed. */
  removePhoto(customerId: string): Promise<CustomerProfileResponse> {
    return this.writePhoto(customerId, null);
  }

  private async writePhoto(
    customerId: string,
    gsUri: string | null,
  ): Promise<CustomerProfileResponse> {
    let replaced: string | null;

    try {
      replaced = await this.prisma.$transaction(async (tx) => {
        const current = await this.lockLive(tx, customerId);

        await tx.customer.update({
          where: { id: customerId },
          data: { photo: gsUri },
        });

        return current.photo;
      });
    } catch (error) {
      await this.photos.removeQuietly(gsUri);
      throw error;
    }

    if (replaced !== gsUri) await this.photos.removeQuietly(replaced);

    return this.profile(customerId);
  }

  private async toProfile(row: ProfileRow): Promise<CustomerProfileResponse> {
    const hasAddress =
      row.addressZone !== null ||
      [
        row.addressStreet,
        row.addressArea,
        row.addressTown,
        row.addressLandmark,
      ].some((part) => part !== null && part !== '');

    return {
      id: row.id,
      memberNo: row.memberNo,
      name: row.name,
      email: row.email,
      phone: row.phone,
      address: hasAddress
        ? {
            zone: row.addressZone,
            street: row.addressStreet ?? '',
            area: row.addressArea ?? '',
            town: row.addressTown ?? '',
            landmark: row.addressLandmark ?? '',
          }
        : null,
      prefs: {
        orderUpdates: row.prefOrderUpdates,
        bookingReminders: row.prefBookingReminders,
        offers: row.prefOffers,
        channel: row.prefChannel,
      },
      photoUrl: await this.photos.signedUrlOrNull(row.photo),
      createdAt: row.createdAt.toISOString(),
      notificationsReadAt: row.notificationsReadAt?.toISOString() ?? null,
    };
  }
}
