import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { canonicalNigerianPhone } from '../common/nigerian-phone';
import {
  MoneyControlService,
  OWNER_ONLY_SETTINGS_MESSAGE,
  OWNER_ONLY_TIMES_MESSAGE,
} from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import type {
  BusinessResponse,
  PublicBusinessResponse,
  SettingsResponse,
} from './dto/settings.response';
import type { UpdateBusinessRequest } from './dto/update-business.request';
import type { UpdateSettingsRequest } from './dto/update-settings.request';
import {
  OWNER_MONEY_SETTINGS,
  OWNER_TIME_SETTINGS,
  SETTINGS_KEYS,
  type SettingsKey,
} from './settings-rules';

type Tx = Prisma.TransactionClient;

/** The client a read runs on: the service's own, or a caller's transaction. */
type Reader = Pick<Tx, 'settings' | 'business'>;

const SETTINGS_SELECT = {
  id: true,
  vatBps: true,
  serviceBps: true,
  depositKobo: true,
  freeTableReminderMinutes: true,
  deliveryJosKobo: true,
  deliveryOutsideKobo: true,
  approvalLimitKobo: true,
  dailyLimitOn: true,
  dailyLimitKobo: true,
  printerWidth: true,
  alertLowStock: true,
  alertApprovals: true,
  alertUnsettled: true,
  alertArrivals: true,
  lastArrivalMinutes: true,
  lastOrderSlotMinutes: true,
  slotStepMinutes: true,
  leadPickupMinutes: true,
  leadJosMinutes: true,
  leadOutsideMinutes: true,
  updatedAt: true,
  version: true,
} satisfies Prisma.SettingsSelect;

type SettingsRow = Prisma.SettingsGetPayload<{
  select: typeof SETTINGS_SELECT;
}>;

const BUSINESS_SELECT = {
  id: true,
  name: true,
  addressLine: true,
  addressLines: true,
  phone: true,
  email: true,
  registration: true,
  mapLat: true,
  mapLng: true,
  socialLinks: true,
  updatedAt: true,
  version: true,
} satisfies Prisma.BusinessSelect;

type BusinessRow = Prisma.BusinessGetPayload<{
  select: typeof BUSINESS_SELECT;
}>;

/** The keys a request names, in the order the rules list them. */
function sentKeys(request: UpdateSettingsRequest): SettingsKey[] {
  return SETTINGS_KEYS.filter((key) => request[key] !== undefined);
}

/**
 * A database that was never seeded has no settings or business row. That
 * is the operator's to fix, and refusing every save with a 403 or 404 would
 * blame the caller for it, so it is a 500 that names the seed, as in
 * `MoneyControlService`.
 */
function missingRow(what: string): Error {
  return new Error(
    `The ${what} row is missing. Run \`npm run db:seed\` on this database.`,
  );
}

/**
 * Settings and business details (plan §5.4, card C3-7): the demo's
 * `settings.save`, split as the plan splits it into `PATCH /staff/settings`
 * and `PATCH /staff/business`, both audited as `settings.save`.
 *
 * Each save is one transaction: the singleton row is taken with
 * `claimVersion` (A8), the Owner rules are checked against the row as it
 * stands, the row is written, and the audit row goes in the same
 * transaction (A6).
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
  ) {}

  /** The settings row, as `GET /staff/settings` and the shell read it. */
  async readSettings(reader: Reader = this.prisma): Promise<SettingsResponse> {
    const row = await reader.settings.findUnique({
      where: { singleton: true },
      select: SETTINGS_SELECT,
    });

    if (row === null) throw missingRow('settings');

    return toSettingsResponse(row);
  }

  /** The business row, as `GET /staff/settings` and the shell read it. */
  async readBusiness(reader: Reader = this.prisma): Promise<BusinessResponse> {
    const row = await reader.business.findUnique({
      where: { singleton: true },
      select: BUSINESS_SELECT,
    });

    if (row === null) throw missingRow('business');

    return toBusinessResponse(row);
  }

  /**
   * The business details as the public reads them (`GET /business`): the
   * staff read without the row's `updatedAt` and `version`, which say
   * nothing to a visitor.
   */
  async readPublicBusiness(): Promise<PublicBusinessResponse> {
    const business = await this.readBusiness();

    return {
      name: business.name,
      addressLine: business.addressLine,
      addressLines: business.addressLines,
      phone: business.phone,
      email: business.email,
      registration: business.registration,
      mapLat: business.mapLat,
      mapLng: business.mapLng,
      socialLinks: business.socialLinks,
    };
  }

  /**
   * `settings.save`. A manager may send an Owner-only key with the value it
   * already has (the screen sends the whole form); changing one is refused
   * with the demo's sentence, and changing a booking or ordering time with
   * Q29's. The money keys are checked first, as the demo checks them.
   */
  async save(
    actor: StaffPrincipal,
    request: UpdateSettingsRequest,
    ipAddress: string,
  ): Promise<SettingsResponse> {
    return this.prisma.$transaction(async (tx) => {
      const id = await this.singletonId(tx, 'settings');

      await claimVersion(tx, {
        table: 'Settings',
        id,
        version: request.version,
        notFound: 'Settings not found.',
      });

      const current = await tx.settings.findUniqueOrThrow({
        where: { id },
        select: SETTINGS_SELECT,
      });

      const changed = sentKeys(request).filter(
        (key) => request[key] !== current[key],
      );

      if (
        changed.some((key) =>
          (OWNER_MONEY_SETTINGS as readonly string[]).includes(key),
        )
      ) {
        this.money.requireOwner(actor, OWNER_ONLY_SETTINGS_MESSAGE);
      }

      if (
        changed.some((key) =>
          (OWNER_TIME_SETTINGS as readonly string[]).includes(key),
        )
      ) {
        this.money.requireOwner(actor, OWNER_ONLY_TIMES_MESSAGE);
      }

      const data: Prisma.SettingsUpdateInput = {};
      for (const key of sentKeys(request)) {
        (data as Record<string, unknown>)[key] = request[key];
      }

      const updated = await tx.settings.update({
        where: { id },
        data,
        select: SETTINGS_SELECT,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'settings.save',
          ref: null,
          before: settingsForAudit(current),
          after: settingsForAudit(updated),
          ipAddress,
        },
        tx,
      );

      return toSettingsResponse(updated);
    });
  }

  /**
   * The business half of `settings.save` (`PATCH /staff/business`):
   * managers may change it; the name, the address and the phone may never
   * end up blank (the DTO refuses a blank one), and the phone is stored in
   * its one form, `0` plus ten digits.
   */
  async saveBusiness(
    actor: StaffPrincipal,
    request: UpdateBusinessRequest,
    ipAddress: string,
  ): Promise<BusinessResponse> {
    return this.prisma.$transaction(async (tx) => {
      const id = await this.singletonId(tx, 'business');

      await claimVersion(tx, {
        table: 'Business',
        id,
        version: request.version,
        notFound: 'Business details not found.',
      });

      const current = await tx.business.findUniqueOrThrow({
        where: { id },
        select: BUSINESS_SELECT,
      });

      const data: Prisma.BusinessUpdateInput = {};
      if (request.name !== undefined) data.name = request.name;
      if (request.addressLine !== undefined) {
        data.addressLine = request.addressLine;
      }
      if (request.addressLines !== undefined) {
        data.addressLines = request.addressLines;
      }
      if (request.phone !== undefined) {
        data.phone = canonicalNigerianPhone(request.phone);
      }
      if (request.email !== undefined) data.email = request.email;
      if (request.registration !== undefined) {
        data.registration = request.registration;
      }
      if (request.mapLat !== undefined) data.mapLat = request.mapLat;
      if (request.mapLng !== undefined) data.mapLng = request.mapLng;
      if (request.socialLinks !== undefined) {
        data.socialLinks = request.socialLinks;
      }

      const updated = await tx.business.update({
        where: { id },
        data,
        select: BUSINESS_SELECT,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'settings.save',
          ref: null,
          before: businessForAudit(current),
          after: businessForAudit(updated),
          ipAddress,
        },
        tx,
      );

      return toBusinessResponse(updated);
    });
  }

  private async singletonId(
    tx: Tx,
    which: 'settings' | 'business',
  ): Promise<string> {
    const row =
      which === 'settings'
        ? await tx.settings.findUnique({
            where: { singleton: true },
            select: { id: true },
          })
        : await tx.business.findUnique({
            where: { singleton: true },
            select: { id: true },
          });

    if (row === null) throw missingRow(which);

    return row.id;
  }
}

function toSettingsResponse(row: SettingsRow): SettingsResponse {
  return {
    vatBps: row.vatBps,
    serviceBps: row.serviceBps,
    depositKobo: row.depositKobo,
    freeTableReminderMinutes: row.freeTableReminderMinutes,
    deliveryJosKobo: row.deliveryJosKobo,
    deliveryOutsideKobo: row.deliveryOutsideKobo,
    approvalLimitKobo: row.approvalLimitKobo,
    dailyLimitOn: row.dailyLimitOn,
    dailyLimitKobo: row.dailyLimitKobo,
    printerWidth: row.printerWidth,
    alertLowStock: row.alertLowStock,
    alertApprovals: row.alertApprovals,
    alertUnsettled: row.alertUnsettled,
    alertArrivals: row.alertArrivals,
    lastArrivalMinutes: row.lastArrivalMinutes,
    lastOrderSlotMinutes: row.lastOrderSlotMinutes,
    slotStepMinutes: row.slotStepMinutes,
    leadPickupMinutes: row.leadPickupMinutes,
    leadJosMinutes: row.leadJosMinutes,
    leadOutsideMinutes: row.leadOutsideMinutes,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** The settings an audit row records: every key `settings.save` writes. */
function settingsForAudit(row: SettingsRow): Record<SettingsKey, unknown> {
  return Object.fromEntries(
    SETTINGS_KEYS.map((key) => [key, row[key]]),
  ) as Record<SettingsKey, unknown>;
}

/** `socialLinks` is JSON; anything but a flat object of strings reads as {}. */
function socialLinksOf(value: Prisma.JsonValue): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function toBusinessResponse(row: BusinessRow): BusinessResponse {
  return {
    name: row.name,
    addressLine: row.addressLine,
    addressLines: row.addressLines,
    phone: row.phone,
    email: row.email,
    registration: row.registration,
    mapLat: row.mapLat,
    mapLng: row.mapLng,
    socialLinks: socialLinksOf(row.socialLinks),
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** What an audit row records of the business details. */
function businessForAudit(row: BusinessRow) {
  return {
    name: row.name,
    addressLine: row.addressLine,
    addressLines: row.addressLines,
    phone: row.phone,
    email: row.email,
    registration: row.registration,
    mapLat: row.mapLat,
    mapLng: row.mapLng,
    socialLinks: socialLinksOf(row.socialLinks),
  };
}
