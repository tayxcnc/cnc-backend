import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { type Prisma, SubjectType } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import { CncTokenService } from '../auth/cnc-token.service';
import { generateTemporaryPassword, hashPassword } from '../auth/password';
import { STAFF_NOT_FOUND_MESSAGE } from '../auth/staff-auth.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager } from '../auth/staff-roles';
import { formatIsoDate } from '../common/calendar-date';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { generateQrToken } from '../common/qr-token';
import { watToday } from '../common/wat';
import { PhotoStore } from '../images/photo-store.service';
import type { UploadedImageFile } from '../images/uploaded-image';
import { MoneyControlService } from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { drawNumber } from '../prisma/sequences';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import type { CreateStaffRequest } from './dto/create-staff.request';
import type { StaffListQuery } from './dto/staff-list.query';
import type {
  StaffCreatedResponse,
  StaffPageResponse,
  StaffPersonResponse,
} from './dto/staff-person.response';
import type { UpdateStaffRequest } from './dto/update-staff.request';
import {
  OWN_PHOTO_ONLY_MESSAGE,
  STAFF_EMAIL_REASON_MESSAGE,
  STAFF_EMAIL_TAKEN_MESSAGE,
  STAFF_NAME_REASON_MESSAGE,
} from './staff-messages';

/**
 * The columns a staff account is answered and audited from. Never
 * `passwordHash` or `qrToken`: a select that cannot name them cannot leak
 * them.
 */
const STAFF_PERSON_SELECT = {
  id: true,
  staffNo: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  photo: true,
  joinedOn: true,
  qrRegeneratedAt: true,
  version: true,
} satisfies Prisma.StaffSelect;

type StaffPersonRow = Prisma.StaffGetPayload<{
  select: typeof STAFF_PERSON_SELECT;
}>;

type Tx = Prisma.TransactionClient;

/**
 * What an audit row records of an account: the fields a person reads in
 * the history, and whether there is a photo (the demo's `hasPhoto`), never
 * the photo itself, the password hash or the QR token.
 */
function auditView(row: StaffPersonRow) {
  return {
    staffNo: row.staffNo,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
    joinedOn: formatIsoDate(row.joinedOn),
    hasPhoto: row.photo !== null,
  };
}

/** A sent reason, trimmed; blank counts as none, as in the demo. */
function reasonOf(reason: string | undefined): string | null {
  const trimmed = reason?.trim();

  return trimmed ? trimmed : null;
}

/** A unique clash on the staff email: a 409 with the demo's sentence. */
function rethrowEmailClash(error: unknown): never {
  if (uniqueViolationTargets(error).includes('email')) {
    throw new ConflictException(STAFF_EMAIL_TAKEN_MESSAGE);
  }

  throw error;
}

/**
 * Staff & Access (plan §5.4, card C3-6): the demo's `staff.save` and
 * `staff.photo`, and the new QR reissue (D44).
 *
 * Each command is one transaction (A6) that takes the row with
 * `claimVersion` first (A8), applies the demo's rules in the demo's order,
 * writes, and records its audit row through the same transaction. The
 * Manager/Owner account rule and the last-Owner rule are
 * `MoneyControlService`'s, so the admin reset and this service apply the
 * same rule with the same sentence.
 *
 * **Every refresh token the account holds is revoked when its role, email
 * or status changes** (A14), inside the same transaction: a demoted or
 * deactivated person keeps no session that outlives the change, and the
 * guard refuses their next request because it reads the row every time.
 */
@Injectable()
export class StaffPeopleService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly tokens: CncTokenService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
    private readonly photos: PhotoStore,
  ) {}

  /** `GET /staff/people`: a page of accounts, by name. */
  async list(query: StaffListQuery): Promise<StaffPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const q = query.q?.trim();

    const where: Prisma.StaffWhereInput = q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { staffNo: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.staff.findMany({
        where,
        select: STAFF_PERSON_SELECT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.staff.count({ where }),
    ]);

    return {
      data: await Promise.all(rows.map((row) => this.toResponse(row))),
      page,
      pageSize,
      total,
    };
  }

  /**
   * `staff.save` for a new person. The first password is a random
   * temporary one, hashed before the transaction opens (argon2id is slow on
   * purpose and must not hold a lock), returned once, and to be replaced at
   * first sign-in, as the admin reset's is.
   */
  async create(
    actor: StaffPrincipal,
    request: CreateStaffRequest,
    ipAddress: string,
  ): Promise<StaffCreatedResponse> {
    // Refused before any hashing: making a Manager or an Owner is the
    // Owner's alone.
    this.money.mayChangeAccount(actor, { newRole: request.role });

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    const created = await this.prisma
      .$transaction(async (tx) => {
        await this.assertEmailFree(tx, request.email, null);

        const row = await tx.staff.create({
          data: {
            staffNo: await drawNumber(tx, 'staff'),
            name: request.name,
            email: request.email,
            role: request.role,
            isActive: request.isActive ?? true,
            passwordHash,
            mustChangePassword: true,
            qrToken: generateQrToken(),
            joinedOn: watToday(new Date()),
          },
          select: STAFF_PERSON_SELECT,
        });

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'staff.save',
            ref: row.staffNo,
            before: null,
            after: auditView(row),
            ipAddress,
          },
          tx,
        );

        return row;
      })
      .catch(rethrowEmailClash);

    return { staff: await this.toResponse(created), temporaryPassword };
  }

  /**
   * `staff.save` for an existing account, in the demo's order: the
   * Manager/Owner rule, the email (free, and a reason when it changes), the
   * name (a reason when it changes), then the last active Owner.
   *
   * A field left out stays as it is; in particular the status changes only
   * when `isActive` is sent (plan §17, R2).
   */
  async update(
    actor: StaffPrincipal,
    id: string,
    request: UpdateStaffRequest,
    ipAddress: string,
  ): Promise<StaffPersonResponse> {
    const updated = await this.prisma
      .$transaction(async (tx) => {
        await claimVersion(tx, {
          table: 'Staff',
          id,
          version: request.version,
          notFound: STAFF_NOT_FOUND_MESSAGE,
        });

        const current = await tx.staff.findUniqueOrThrow({
          where: { id },
          select: STAFF_PERSON_SELECT,
        });

        this.money.mayChangeAccount(actor, {
          currentRole: current.role,
          newRole: request.role,
        });

        const reason = reasonOf(request.reason);
        const email = request.email ?? current.email;

        if (email !== current.email) {
          await this.assertEmailFree(tx, email, id);

          if (reason === null) {
            throw new BadRequestException(STAFF_EMAIL_REASON_MESSAGE);
          }
        }

        const name = request.name ?? current.name;

        if (name !== current.name && reason === null) {
          throw new BadRequestException(STAFF_NAME_REASON_MESSAGE);
        }

        const role = request.role ?? current.role;
        const isActive = request.isActive ?? current.isActive;

        await this.money.keepsAnActiveOwner(tx, {
          staffId: id,
          currentRole: current.role,
          newRole: role,
          newIsActive: isActive,
        });

        const row = await tx.staff.update({
          where: { id },
          data: { name, email, role, isActive },
          select: STAFF_PERSON_SELECT,
        });

        if (
          email !== current.email ||
          role !== current.role ||
          isActive !== current.isActive
        ) {
          await this.tokens.revokeAllForSubject(id, SubjectType.STAFF, tx);
        }

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'staff.save',
            ref: row.staffNo,
            before: auditView(current),
            after: auditView(row),
            reason,
            ipAddress,
          },
          tx,
        );

        return row;
      })
      .catch(rethrowEmailClash);

    return this.toResponse(updated);
  }

  /**
   * `staff.photo`: replace a photograph, the person's own or, for a
   * manager, anyone's (D43). The upload is checked and stored before the
   * transaction (see `PhotoStore`); a refused command removes it again.
   */
  async replacePhoto(
    actor: StaffPrincipal,
    id: string,
    version: number,
    file: UploadedImageFile | undefined,
    ipAddress: string,
  ): Promise<StaffPersonResponse> {
    this.assertMayChangePhoto(actor, id);

    const gsUri = await this.photos.store('staff', id, file);

    return this.writePhoto(actor, id, version, gsUri, ipAddress);
  }

  /** `staff.photo` removing the photograph: self or a manager. */
  async removePhoto(
    actor: StaffPrincipal,
    id: string,
    version: number,
    ipAddress: string,
  ): Promise<StaffPersonResponse> {
    this.assertMayChangePhoto(actor, id);

    return this.writePhoto(actor, id, version, null, ipAddress);
  }

  /**
   * Reissue a staff ID (D44): a fresh QR token, so a lost or copied card
   * stops working. The staff number and the attendance history are kept
   * (Q12); only the token changes, and it is never returned. Managers only,
   * and a Manager or Owner account only by the Owner, as for every other
   * change to such an account.
   */
  async regenerateQr(
    actor: StaffPrincipal,
    id: string,
    version: number,
    ipAddress: string,
  ): Promise<StaffPersonResponse> {
    const updated = await this.prisma.$transaction(async (tx) => {
      await claimVersion(tx, {
        table: 'Staff',
        id,
        version,
        notFound: STAFF_NOT_FOUND_MESSAGE,
      });

      const current = await tx.staff.findUniqueOrThrow({
        where: { id },
        select: STAFF_PERSON_SELECT,
      });

      this.money.mayChangeAccount(actor, { currentRole: current.role });

      const row = await tx.staff.update({
        where: { id },
        data: { qrToken: generateQrToken(), qrRegeneratedAt: new Date() },
        select: STAFF_PERSON_SELECT,
      });

      // The instants only: the token is a credential and AuditService
      // refuses a row that carries one.
      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'staff.regenerateQr',
          ref: row.staffNo,
          before: { qrRegeneratedAt: current.qrRegeneratedAt },
          after: { qrRegeneratedAt: row.qrRegeneratedAt },
          ipAddress,
        },
        tx,
      );

      return row;
    });

    return this.toResponse(updated);
  }

  /** The demo's `staff.photo` rule: your own, or anyone's as a manager. */
  private assertMayChangePhoto(actor: StaffPrincipal, id: string): void {
    if (!isManager(actor.role) && actor.id !== id) {
      throw new ForbiddenException(OWN_PHOTO_ONLY_MESSAGE);
    }
  }

  /**
   * Point the row at a new photo (or none), audit it, and tidy the bucket:
   * the replaced object after the commit, or the new one if the command
   * failed.
   */
  private async writePhoto(
    actor: StaffPrincipal,
    id: string,
    version: number,
    gsUri: string | null,
    ipAddress: string,
  ): Promise<StaffPersonResponse> {
    let result: { row: StaffPersonRow; replaced: string | null };

    try {
      result = await this.prisma.$transaction(async (tx) => {
        await claimVersion(tx, {
          table: 'Staff',
          id,
          version,
          notFound: STAFF_NOT_FOUND_MESSAGE,
        });

        const current = await tx.staff.findUniqueOrThrow({
          where: { id },
          select: { photo: true },
        });

        const row = await tx.staff.update({
          where: { id },
          data: { photo: gsUri },
          select: STAFF_PERSON_SELECT,
        });

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'staff.photo',
            ref: row.staffNo,
            before: { hasPhoto: current.photo !== null },
            after: { hasPhoto: gsUri !== null },
            ipAddress,
          },
          tx,
        );

        return { row, replaced: current.photo };
      });
    } catch (error) {
      await this.photos.removeQuietly(gsUri);
      throw error;
    }

    if (result.replaced !== gsUri) {
      await this.photos.removeQuietly(result.replaced);
    }

    return this.toResponse(result.row);
  }

  /**
   * 409 when another account holds the email. Checked by query for the
   * demo's sentence; the unique index still decides a race, and its clash
   * is turned into the same 409 by `rethrowEmailClash`.
   */
  private async assertEmailFree(
    tx: Tx,
    email: string,
    exceptId: string | null,
  ): Promise<void> {
    const holder = await tx.staff.findUnique({
      where: { email },
      select: { id: true },
    });

    if (holder !== null && holder.id !== exceptId) {
      throw new ConflictException(STAFF_EMAIL_TAKEN_MESSAGE);
    }
  }

  /** The row as the API answers it, field by field, with a signed photo. */
  private async toResponse(row: StaffPersonRow): Promise<StaffPersonResponse> {
    return {
      id: row.id,
      staffNo: row.staffNo,
      name: row.name,
      email: row.email,
      role: row.role,
      isActive: row.isActive,
      mustChangePassword: row.mustChangePassword,
      photoUrl: await this.photos.signedUrlOrNull(row.photo),
      joinedOn: formatIsoDate(row.joinedOn),
      qrRegeneratedAt: row.qrRegeneratedAt,
      version: row.version,
    };
  }
}
