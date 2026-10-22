import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import type {
  CreateVendorRequest,
  SaveVendorFields,
  UpdateVendorRequest,
  VendorPageResponse,
  VendorResponse,
  VendorsQuery,
} from './dto/vendors.dto';
import { VENDOR_NOT_FOUND_MESSAGE } from './purchasing-messages';

type Tx = Prisma.TransactionClient;

/** The columns a vendor is answered from. */
const VENDOR_COLUMNS = {
  id: true,
  name: true,
  service: true,
  phone: true,
  email: true,
  contact: true,
  address: true,
  notes: true,
  isActive: true,
  version: true,
} satisfies Prisma.VendorSelect;

/** The profile fields as stored: an optional text left out is empty. */
function profileOf(request: SaveVendorFields) {
  return {
    name: request.name,
    phone: request.phone,
    service: request.service ?? '',
    contact: request.contact ?? '',
    email: request.email ?? '',
    address: request.address ?? '',
    notes: request.notes ?? '',
  };
}

/** What an audit row says about a vendor: the profile, never more. */
function auditView(vendor: VendorResponse) {
  return {
    name: vendor.name,
    service: vendor.service,
    phone: vendor.phone,
    email: vendor.email,
    contact: vendor.contact,
    address: vendor.address,
    notes: vendor.notes,
    isActive: vendor.isActive,
  };
}

/**
 * Vendors (plan §4.6, §5.4; card C5-3): `vendor.save` for the Storekeeper
 * and managers, and the Vendors list. A vendor is a contact, never a
 * login, and is made inactive, never deleted, so every purchase and repair
 * that names one still resolves. The lite list every form picks from is on
 * `GET /staff/reference`.
 *
 * Each save is one transaction with its audit row (A6). An audit row's ref
 * is the vendor's id: a vendor has no human number, and the demo filed
 * `vendor.save` under its id too.
 */
@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** `GET /staff/vendors`: by name, active and inactive alike, as the screen lists them. */
  async list(query: VendorsQuery): Promise<VendorPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const contains = (value: string) => ({
      contains: value,
      mode: Prisma.QueryMode.insensitive,
    });
    const where: Prisma.VendorWhereInput = query.q
      ? {
          OR: [
            { name: contains(query.q) },
            { service: contains(query.q) },
            { contact: contains(query.q) },
            { email: contains(query.q) },
          ],
        }
      : {};

    const data = await this.prisma.vendor.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: VENDOR_COLUMNS,
    });
    const total = await this.prisma.vendor.count({ where });

    return { data, page, pageSize, total };
  }

  /**
   * `vendor.save`, a new vendor. Runs inside the idempotency service's
   * transaction: a retry after a lost response replays the first save
   * instead of adding the vendor twice.
   */
  async create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateVendorRequest,
    ipAddress: string,
  ): Promise<VendorResponse> {
    const vendor = await tx.vendor.create({
      data: { ...profileOf(request), isActive: request.isActive ?? true },
      select: VENDOR_COLUMNS,
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'vendor.save',
        ref: vendor.id,
        after: auditView(vendor),
        ipAddress,
      },
      tx,
    );

    return vendor;
  }

  /**
   * `vendor.save`, an existing vendor: the whole profile is replaced, and
   * the status only when it is sent (R2's rule, applied here: a phone fix
   * must not make an inactive vendor active again).
   */
  async update(
    actor: StaffPrincipal,
    id: string,
    request: UpdateVendorRequest,
    ipAddress: string,
  ): Promise<VendorResponse> {
    return this.prisma.$transaction(async (tx) => {
      await claimVersion(tx, {
        table: 'Vendor',
        id,
        version: request.version,
        notFound: VENDOR_NOT_FOUND_MESSAGE,
      });

      const before = await tx.vendor.findUniqueOrThrow({
        where: { id },
        select: VENDOR_COLUMNS,
      });
      const after = await tx.vendor.update({
        where: { id },
        data: {
          ...profileOf(request),
          ...(request.isActive !== undefined
            ? { isActive: request.isActive }
            : {}),
        },
        select: VENDOR_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'vendor.save',
          ref: id,
          before: auditView(before),
          after: auditView(after),
          ipAddress,
        },
        tx,
      );

      return after;
    });
  }
}
