import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { type Prisma, SubjectType } from '../../generated/cnc-client';
import { base64UrlBytes } from '../config/vapid';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { PUSH_KEYS_MESSAGE, type PushSubscribeRequest } from './dto/push.dto';
import { PUSH_ENDPOINT_MESSAGE, pushEndpointProblem } from './push-hosts';

/**
 * The DI token for the VAPID public key the routes serve and a subscribe is
 * checked against: `CncConfigService.vapid()?.publicKey`, or null where push
 * is not configured. A provider of its own so the e2e harness can serve the
 * test pair's key, or none (`createTestApp({ push: 'unconfigured' })`).
 */
export const PUSH_PUBLIC_KEY = Symbol('PUSH_PUBLIC_KEY');

/** The public-key routes and a subscribe, where push is not configured: 404. */
export const PUSH_NOT_CONFIGURED_MESSAGE =
  'Notifications are not set up on this service yet.';

/** A subscription made with a key that is not the service's now: 409 (D12). */
export const PUSH_KEY_MISMATCH_MESSAGE =
  "This device's notifications were set up for a different key. Turn them on again.";

/** A subscribe with no live session behind its access token: 401 (D4). */
export const PUSH_SESSION_ENDED_MESSAGE =
  'Your session has ended. Sign in again.';

/** The most devices one person keeps; a new one evicts the least recent. */
export const MAX_PUSH_DEVICES_PER_OWNER = 10;

/** The longest user agent kept, as the column holds it. */
export const USER_AGENT_MAX = 200;

/** An uncompressed P-256 point, and the 16-byte auth secret (RFC 8291). */
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;

/** Which realm's table a subscription lives in. */
export type PushRealm = 'CUSTOMER' | 'STAFF';

/** One stored device, as the ownership rule reads it. */
interface StoredDevice {
  id: string;
  ownerId: string;
  p256dh: string;
  auth: string;
}

/** The fields a subscribe writes, whichever the realm. */
interface DeviceFields {
  p256dh: string;
  auth: string;
  userAgent: string | null;
  lastSeenAt: Date;
}

/**
 * One realm's subscription table, behind the five operations the service
 * needs, so the rules below are written once for both.
 */
interface DeviceTable {
  find(endpoint: string): Promise<StoredDevice | null>;
  create(
    ownerId: string,
    endpoint: string,
    fields: DeviceFields,
  ): Promise<void>;
  update(id: string, ownerId: string, fields: DeviceFields): Promise<void>;
  /** The owner's devices, most recently seen first. */
  owned(ownerId: string): Promise<{ id: string }[]>;
  /** Always one owner's rows: never a delete without its owner. */
  remove(where: {
    ownerId: string;
    ids?: string[];
    endpoint?: string;
  }): Promise<void>;
}

function deviceTable(
  tx: Pick<
    Prisma.TransactionClient,
    'customerPushSubscription' | 'staffPushSubscription'
  >,
  realm: PushRealm,
): DeviceTable {
  if (realm === 'CUSTOMER') {
    const table = tx.customerPushSubscription;

    return {
      find: async (endpoint) => {
        const row = await table.findUnique({
          where: { endpoint },
          select: { id: true, customerId: true, p256dh: true, auth: true },
        });

        return row === null ? null : { ...row, ownerId: row.customerId };
      },
      create: async (customerId, endpoint, fields) => {
        await table.createMany({
          data: [{ customerId, endpoint, ...fields }],
          skipDuplicates: true,
        });
      },
      update: async (id, customerId, fields) => {
        await table.update({ where: { id }, data: { customerId, ...fields } });
      },
      owned: (customerId) =>
        table.findMany({
          where: { customerId },
          orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
          select: { id: true },
        }),
      remove: async ({ ids, ownerId, endpoint }) => {
        await table.deleteMany({
          where: { id: ids && { in: ids }, customerId: ownerId, endpoint },
        });
      },
    };
  }

  const table = tx.staffPushSubscription;

  return {
    find: async (endpoint) => {
      const row = await table.findUnique({
        where: { endpoint },
        select: { id: true, staffId: true, p256dh: true, auth: true },
      });

      return row === null ? null : { ...row, ownerId: row.staffId };
    },
    create: async (staffId, endpoint, fields) => {
      await table.createMany({
        data: [{ staffId, endpoint, ...fields }],
        skipDuplicates: true,
      });
    },
    update: async (id, staffId, fields) => {
      await table.update({ where: { id }, data: { staffId, ...fields } });
    },
    owned: (staffId) =>
      table.findMany({
        where: { staffId },
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
        select: { id: true },
      }),
    remove: async ({ ids, ownerId, endpoint }) => {
      await table.deleteMany({
        where: { id: ids && { in: ids }, staffId: ownerId, endpoint },
      });
    },
  };
}

/** The host of an endpoint, for a log line; never the endpoint itself. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'an unreadable address';
  }
}

/**
 * A person binding and releasing this browser's push subscription (C10,
 * spec §2.5), in both realms.
 *
 * **No answer ever carries an endpoint, a key or a stored row**: the routes
 * answer 204, and the endpoint names a person's device.
 */
@Injectable()
export class PushSubscriptionsService {
  private readonly logger = new Logger(PushSubscriptionsService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    @Inject(PUSH_PUBLIC_KEY) private readonly publicKey: string | null,
  ) {}

  /** The key a browser subscribes with; 404 where push is not configured. */
  servedKey(): string {
    if (this.publicKey === null) {
      throw new NotFoundException(PUSH_NOT_CONFIGURED_MESSAGE);
    }

    return this.publicKey;
  }

  /**
   * Store this browser's subscription for the caller, in one transaction:
   *
   * 1. The keys decode to 65 and 16 bytes and the endpoint names a known
   *    push service (D13), else 400.
   * 2. It was made with the service's current key, else 409 (D12): the
   *    device subscribes again rather than burn every push on a 403.
   * 3. The caller still holds a live refresh token, else 401 (D4): an
   *    access token outlives a sign-out by up to 15 minutes, and must not
   *    bind a device the revocation just forgot. The token rows are read
   *    `FOR SHARE`, so a revocation running now either commits first (and
   *    this answers 401) or waits for this to commit (and then forgets the
   *    device it bound).
   * 4. Ownership by endpoint: a new one is stored; the caller's own is
   *    refreshed; **someone else's moves only when the keys match**, which
   *    a genuinely shared device's do; otherwise nothing is written and the
   *    answer is still 204, so a stranger who learned an endpoint can
   *    neither take it nor learn whose it is.
   * 5. At most `MAX_PUSH_DEVICES_PER_OWNER`: the least recently seen go.
   */
  async subscribe(
    realm: PushRealm,
    ownerId: string,
    body: PushSubscribeRequest,
    userAgent: string | undefined,
  ): Promise<void> {
    if (
      base64UrlBytes(body.keys.p256dh) !== P256DH_BYTES ||
      base64UrlBytes(body.keys.auth) !== AUTH_BYTES
    ) {
      throw new BadRequestException(PUSH_KEYS_MESSAGE);
    }

    if (pushEndpointProblem(body.endpoint) !== null) {
      this.logger.warn(
        `A subscription to ${hostOf(body.endpoint)} was refused: not a ` +
          'known push service.',
      );
      throw new BadRequestException(PUSH_ENDPOINT_MESSAGE);
    }

    // The bytes, not the text: the same key, padded by the browser's
    // encoder, is still the key this service serves.
    if (
      !Buffer.from(body.applicationServerKey, 'base64url').equals(
        Buffer.from(this.servedKey(), 'base64url'),
      )
    ) {
      throw new ConflictException(PUSH_KEY_MISMATCH_MESSAGE);
    }

    const now = new Date();
    const subjectType =
      realm === 'CUSTOMER' ? SubjectType.CUSTOMER : SubjectType.STAFF;

    await this.prisma.$transaction(async (tx) => {
      // The lock first, then the typed read: a revocation's UPDATE of these
      // rows waits for this transaction from here on.
      await tx.$queryRaw`
        SELECT "id" FROM "RefreshToken"
        WHERE "subjectId" = ${ownerId}
          AND "subjectType" = ${subjectType}::"SubjectType"
          AND "revokedAt" IS NULL
        FOR SHARE`;

      const live = await tx.refreshToken.findFirst({
        where: {
          subjectId: ownerId,
          subjectType,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      });

      if (live === null) {
        throw new UnauthorizedException(PUSH_SESSION_ENDED_MESSAGE);
      }

      const devices = deviceTable(tx, realm);
      const fields: DeviceFields = {
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: userAgent?.slice(0, USER_AGENT_MAX) ?? null,
        lastSeenAt: now,
      };
      const stored = await devices.find(body.endpoint);

      if (stored === null) {
        await devices.create(ownerId, body.endpoint, fields);
      } else if (stored.ownerId === ownerId) {
        await devices.update(stored.id, ownerId, fields);
      } else if (
        stored.p256dh === fields.p256dh &&
        stored.auth === fields.auth
      ) {
        await devices.update(stored.id, ownerId, fields);
      } else {
        return;
      }

      const owned = await devices.owned(ownerId);

      if (owned.length > MAX_PUSH_DEVICES_PER_OWNER) {
        await devices.remove({
          ids: owned.slice(MAX_PUSH_DEVICES_PER_OWNER).map(({ id }) => id),
          ownerId,
        });
      }
    });
  }

  /** Remove the caller's own subscription; anyone else's is left alone. */
  async unsubscribe(
    realm: PushRealm,
    ownerId: string,
    endpoint: string,
  ): Promise<void> {
    await deviceTable(this.prisma, realm).remove({ ownerId, endpoint });
  }
}
