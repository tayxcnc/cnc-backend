import { randomUUID } from 'node:crypto';
import { type StaffRole, SubjectType } from '../generated/cnc-client';
import { hashPassword } from '../src/auth/password';
import type { CncTokenService } from '../src/auth/cnc-token.service';
import type { StaffPrincipal } from '../src/auth/staff-principal';
import { generateQrToken } from '../src/common/qr-token';
import { watToday } from '../src/common/wat';
import type { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';

/** A staff account a suite created, with the password it was given. */
export interface StaffAccount extends StaffPrincipal {
  email: string;
  password: string;
}

/**
 * A run-unique staff account with a known password, committed to the test
 * database and never removed (every e2e suite leaves its rows). Shared by
 * the suites that sign staff in, so the account's shape is written once.
 */
export async function createStaffAccount(
  prisma: CncPrismaService,
  role: StaffRole,
  options: {
    isActive?: boolean;
    mustChangePassword?: boolean;
    /** The email's first part, before the run-unique id. */
    emailPrefix?: string;
    name?: string;
  } = {},
): Promise<StaffAccount> {
  const email = `${options.emailPrefix ?? 'staff'}-${randomUUID()}@cnc.test`;
  const password = `pw-${randomUUID()}`;

  const staff = await prisma.staff.create({
    data: {
      staffNo: await drawNumber(prisma, 'staff'),
      name: options.name ?? `Test ${role.toLowerCase()}`,
      email,
      role,
      isActive: options.isActive ?? true,
      passwordHash: await hashPassword(password),
      mustChangePassword: options.mustChangePassword ?? false,
      qrToken: generateQrToken(),
      joinedOn: watToday(new Date()),
    },
    select: { id: true, staffNo: true, name: true, role: true },
  });

  return { ...staff, email, password };
}

/**
 * An access token for an account, minted directly rather than through the
 * sign-in route, so a suite that is not about sign-in never meets its
 * throttle.
 */
export async function accessTokenFor(
  tokens: CncTokenService,
  staffId: string,
): Promise<string> {
  const pair = await tokens.issueTokenPair(staffId, SubjectType.STAFF);

  return pair.accessToken;
}
