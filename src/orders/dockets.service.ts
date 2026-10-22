import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type Fulfilment,
  type OrderChannel,
  Prisma,
} from '../../generated/cnc-client';
import { formatIsoDate, parseIsoDate } from '../common/calendar-date';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  docketRef,
  normaliseDocketRef,
  parseDocketItems,
  type DocketItem,
} from './docket-items';
import type { DocketListQuery } from './dto/docket.request';
import type { DocketPageResponse, DocketResponse } from './dto/order.response';
import { DOCKET_NOT_FOUND_MESSAGE } from './order-messages';

type Tx = Prisma.TransactionClient;

/** Either the base client or a command's transaction. */
type Reader = Pick<Tx, 'docket' | 'order' | 'staff' | '$queryRaw'>;

/** The columns a docket is answered from. */
const DOCKET_COLUMNS = {
  id: true,
  ref: true,
  orderId: true,
  revision: true,
  businessDate: true,
  items: true,
  notes: true,
  staffId: true,
  channel: true,
  fulfilment: true,
  scheduledFor: true,
  createdAt: true,
} satisfies Prisma.DocketSelect;

type DocketRow = Prisma.DocketGetPayload<{ select: typeof DOCKET_COLUMNS }>;

/** What a new docket revision is written from. */
export interface NewDocket {
  orderId: string;
  orderNumber: string;
  revision: number;
  /** The order's business date: a carried order's docket keeps its day. */
  businessDate: Date;
  /** The confirmed Restaurant lines; empty for a cancellation docket. */
  items: readonly DocketItem[];
  notes: string;
  /** Null for a web docket. */
  staffId: string | null;
  channel: OrderChannel;
  fulfilment?: Fulfilment | null;
  scheduledFor?: Date | null;
}

/**
 * Kitchen dockets (plan §4.3, §7.1; card C4-4): the one writer of `Docket`
 * rows, and the reads the Kitchen screen makes by the number typed from
 * paper.
 *
 * A docket revision is immutable once written: a change to the bill is a
 * new revision with the full list, and a confirm with no change reprints
 * the latest. `write` is exported for the cancellation docket (C4-5) and
 * the web docket (C7), so every docket is shaped here.
 */
@Injectable()
export class DocketsService {
  constructor(private readonly prisma: CncPrismaService) {}

  /**
   * Write revision `revision` of an order's docket, inside the command's
   * transaction (whose order row is already locked, so two confirms cannot
   * both write one revision; the unique (`orderId`, `revision`) index
   * refuses it if they ever did).
   */
  async write(tx: Tx, docket: NewDocket): Promise<DocketResponse> {
    const row = await tx.docket.create({
      data: {
        ref: docketRef(docket.orderNumber),
        orderId: docket.orderId,
        revision: docket.revision,
        businessDate: docket.businessDate,
        items: docket.items.map((item) => ({
          menuItemId: item.menuItemId,
          name: item.name,
          option: item.option,
          qty: item.qty,
          unitPriceKobo: item.unitPriceKobo,
        })),
        notes: docket.notes,
        staffId: docket.staffId,
        channel: docket.channel,
        fulfilment: docket.fulfilment ?? null,
        scheduledFor: docket.scheduledFor ?? null,
      },
      select: DOCKET_COLUMNS,
    });

    return this.toResponse(tx, row, docket.orderNumber);
  }

  /** An order's latest docket revision, or null if it was never sent. */
  async latestForOrder(
    client: Reader,
    orderId: string,
    orderNumber: string,
  ): Promise<DocketResponse | null> {
    const row = await client.docket.findFirst({
      where: { orderId },
      orderBy: { revision: 'desc' },
      select: DOCKET_COLUMNS,
    });

    return row === null ? null : this.toResponse(client, row, orderNumber);
  }

  /**
   * The latest revision printed under a ref, as typed from paper (trimmed,
   * any case), or null. The kitchen entry (C4-6) takes its order, date and
   * revision from it.
   */
  async latestByRef(
    client: Reader,
    refText: string,
  ): Promise<DocketResponse | null> {
    const ref = normaliseDocketRef(refText);
    const row = await client.docket.findFirst({
      where: { ref },
      orderBy: { revision: 'desc' },
      select: DOCKET_COLUMNS,
    });

    if (row === null) return null;

    const order = await client.order.findUniqueOrThrow({
      where: { id: row.orderId },
      select: { number: true },
    });

    return this.toResponse(client, row, order.number);
  }

  /** `GET /staff/dockets/:ref`: the latest revision, or 404. */
  async byRef(refText: string): Promise<DocketResponse> {
    const docket = await this.latestByRef(this.prisma, refText);

    if (docket === null) throw new NotFoundException(DOCKET_NOT_FOUND_MESSAGE);

    return docket;
  }

  /**
   * `GET /staff/dockets?date&channel`: one business date's dockets, the
   * latest revision of each ref, newest first. The Kitchen and the Cashier
   * print the day's web dockets from it (plan §5.4, Q8).
   */
  async list(query: DocketListQuery): Promise<DocketPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    // Bound as the `YYYY-MM-DD` text, never a Date: a Date travels as an
    // instant, and its cast to `date` would follow the session's zone.
    const date = formatIsoDate(
      (query.date === undefined ? null : parseIsoDate(query.date)) ??
        watToday(new Date()),
    );
    const channel =
      query.channel === undefined
        ? Prisma.empty
        : Prisma.sql`AND d."channel" = ${query.channel}::"OrderChannel"`;

    const latest = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM (
        SELECT DISTINCT ON (d."ref") d."id", d."createdAt"
          FROM "Docket" d
         WHERE d."businessDate" = ${date}::date ${channel}
         ORDER BY d."ref", d."revision" DESC
      ) latest
      ORDER BY latest."createdAt" DESC, latest."id" DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const [{ total }] = await this.prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(DISTINCT d."ref")::bigint AS "total"
        FROM "Docket" d
       WHERE d."businessDate" = ${date}::date ${channel}`;

    const data: DocketResponse[] = [];

    for (const { id } of latest) {
      const row = await this.prisma.docket.findUniqueOrThrow({
        where: { id },
        select: DOCKET_COLUMNS,
      });
      const order = await this.prisma.order.findUniqueOrThrow({
        where: { id: row.orderId },
        select: { number: true },
      });

      data.push(await this.toResponse(this.prisma, row, order.number));
    }

    return { data, page, pageSize, total: Number(total) };
  }

  /** A docket row as the API answers it, with its writer's name. */
  private async toResponse(
    client: Reader,
    row: DocketRow,
    orderNumber: string,
  ): Promise<DocketResponse> {
    const staff =
      row.staffId === null
        ? null
        : await client.staff.findUnique({
            where: { id: row.staffId },
            select: { name: true },
          });
    const items = parseDocketItems(row.items);

    return {
      id: row.id,
      ref: row.ref,
      orderId: row.orderId,
      orderNumber,
      revision: row.revision,
      businessDate: formatIsoDate(row.businessDate),
      items,
      notes: row.notes,
      staffId: row.staffId,
      staffName: staff?.name ?? null,
      channel: row.channel,
      fulfilment: row.fulfilment,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      cancellation: items.length === 0,
    };
  }
}
