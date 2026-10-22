import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ContactChannel, type Prisma } from '../../generated/cnc-client';
import { ACCOUNT_GONE_MESSAGE } from '../auth/guards/cnc-staff.guard';
import { PhotoStore } from '../images/photo-store.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { drawNumber } from '../prisma/sequences';
import type { CustomerProfileResponse } from './dto/customer-profile.response';
import type { UpdateMeRequest } from './dto/update-me.request';

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

/**
 * Customers (plan §4.2): finding or creating one from a verified email, and
 * the profile every session response and `GET /me` return. The one place a
 * customer row is created, so the member number, the lock and the
 * defaults are decided once; checkout's "Save my details" (C7) creates
 * through here too.
 */
@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly photos: PhotoStore,
  ) {}

  /**
   * The customer holding `email`, created when there is none, with the
   * email marked verified: the caller has just proved it with a code.
   *
   * Under an advisory lock on the email, so two first sign-ins with one
   * address (or a sign-in racing checkout's create, C7) make one customer,
   * not a unique-index 500. The member number is drawn only when a row is
   * created, so returning customers burn none. A new customer's name is
   * empty until the first-time name step saves it (the account app's
   * `isNew || !name`), and their channel is email (Q5).
   */
  async findOrCreateVerified(
    tx: Tx,
    email: string,
  ): Promise<{ id: string; isNew: boolean }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cnc:customer-email:${email}`}))`;

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

    return { id: created.id, isNew: true };
  }

  /** The customer's profile. 401 when the row is gone. */
  async profile(customerId: string): Promise<CustomerProfileResponse> {
    const row = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: PROFILE_SELECT,
    });

    if (row === null) {
      throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);
    }

    return this.toProfile(row);
  }

  /** `PATCH /me`: each field only when it is sent. */
  async update(
    customerId: string,
    request: UpdateMeRequest,
  ): Promise<CustomerProfileResponse> {
    const data: Prisma.CustomerUpdateInput = {};

    if (typeof request.name === 'string') data.name = request.name;

    if (Object.keys(data).length > 0) {
      const { count } = await this.prisma.customer.updateMany({
        where: { id: customerId },
        data,
      });

      if (count !== 1) {
        throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);
      }
    }

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
