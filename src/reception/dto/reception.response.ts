import { ApiProperty } from '@nestjs/swagger';
import {
  Department,
  OrderStatus,
  ReservationSource,
  ReservationStatus,
  TableKind,
  TableSessionStatus,
} from '../../../generated/cnc-client';
import { FLOOR_STATUSES, type FloorStatus } from '../reservation-rules';

/** A booking (plan §4.5), as Reception reads it. */
export class ReservationResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'RSV-000001' }) number!: string;
  @ApiProperty() tableId!: string;
  @ApiProperty({
    example: 'L-TS1',
    description: 'Room initial and table code.',
  })
  tableRef!: string;
  @ApiProperty({ example: 'Lounge table 1' }) tableName!: string;
  @ApiProperty({ example: 'lounge' }) venueSlug!: string;
  @ApiProperty({ example: 'Lounge' }) venueName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The customer account the booking is linked to (Q35: an exact match ' +
      'to a verified email or phone), or null.',
  })
  customerId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ example: '08031234567' }) phone!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ example: '2026-10-22' }) businessDate!: string;
  @ApiProperty({ example: '19:00', description: 'Arrival time in Jos.' })
  time!: string;
  @ApiProperty({ example: 1140 }) startMinutes!: number;
  @ApiProperty({ example: 2 }) party!: number;
  @ApiProperty({ enum: ReservationStatus, enumName: 'ReservationStatus' })
  status!: ReservationStatus;
  @ApiProperty({ enum: ReservationSource, enumName: 'ReservationSource' })
  source!: ReservationSource;
  @ApiProperty() note!: string;
  @ApiProperty({ description: 'Always 0 at launch (D38).' })
  depositKobo!: number;
  @ApiProperty() depositUsedKobo!: number;
  @ApiProperty({ type: String, nullable: true }) cancelledAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: 'The `version` the next write names (A8).' })
  version!: number;
}

/** `GET /staff/reservations`. */
export class ReservationPageResponse {
  @ApiProperty({ type: ReservationResponse, isArray: true })
  data!: ReservationResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/** A table's seating or lock (plan §4.5 `TableSession`). */
export class TableSessionResponse {
  @ApiProperty() id!: string;
  @ApiProperty() tableId!: string;
  @ApiProperty({ example: 'D-B1' }) tableRef!: string;
  @ApiProperty({ example: 'Booth 1' }) tableName!: string;
  @ApiProperty({ enum: TableSessionStatus, enumName: 'TableSessionStatus' })
  status!: TableSessionStatus;
  @ApiProperty({ description: 'Occupied: the guests. Locked: blank.' })
  guest!: string;
  @ApiProperty() party!: number;
  @ApiProperty({ description: 'Locked: the reason. Occupied: blank.' })
  note!: string;
  @ApiProperty() since!: string;
  @ApiProperty({ type: String, nullable: true }) endedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The booking checked in to this seating, if any.',
  })
  reservationId!: string | null;
  @ApiProperty() openedByName!: string;
  @ApiProperty({
    description:
      'Occupied for at least the Free Table Reminder time (Settings), and ' +
      'still open.',
  })
  reminderDue!: boolean;
  @ApiProperty({ description: 'The `version` a release names (A8).' })
  version!: number;
}

/** `reservation.checkin`: the booking, now Checked In, and the seating it opened. */
export class CheckInResponse {
  @ApiProperty({ type: ReservationResponse })
  reservation!: ReservationResponse;
  @ApiProperty({ type: TableSessionResponse })
  session!: TableSessionResponse;
}

/** `table.release`: the ended session and the bookings it completed. */
export class TableReleaseResponse {
  @ApiProperty({ type: TableSessionResponse })
  session!: TableSessionResponse;
  @ApiProperty({
    type: String,
    isArray: true,
    example: ['RSV-000001'],
    description: 'The Checked In bookings on the table, now Completed.',
  })
  completedReservations!: string[];
}

/** A booking on the floor. Point of Sale roles get no phone or email. */
export class FloorReservationResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'RSV-000001' }) number!: string;
  @ApiProperty() name!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null for Point of Sale roles (plan §6.1).',
  })
  phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ example: '19:00' }) time!: string;
  @ApiProperty() party!: number;
  @ApiProperty({ enum: ReservationStatus, enumName: 'ReservationStatus' })
  status!: ReservationStatus;
  @ApiProperty() note!: string;
  @ApiProperty() depositKobo!: number;
  @ApiProperty() depositUsedKobo!: number;
  @ApiProperty() version!: number;
}

/** A bill still open on the table, of any date (plan §7.1 step 6). */
export class FloorOrderResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'CNCR-000001' }) number!: string;
  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' })
  status!: OrderStatus;
}

/** One table on the floor (plan §5.4 Reception). */
export class FloorTableResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'D-B1' }) ref!: string;
  @ApiProperty({ example: 'B1' }) code!: string;
  @ApiProperty({ example: 'Booth 1' }) name!: string;
  @ApiProperty({ enum: TableKind, enumName: 'TableKind' }) kind!: TableKind;
  @ApiProperty() capacity!: number;
  @ApiProperty({ example: 'dining' }) venueSlug!: string;
  @ApiProperty({ example: 'Diner' }) venueName!: string;
  @ApiProperty({
    enum: FLOOR_STATUSES,
    enumName: 'FloorStatus',
    description:
      'Locked: a Locked session. Occupied: guests seated, today only. ' +
      'Reserved: a Confirmed or Checked In booking on the date. Otherwise ' +
      'Available (plan §7.5).',
  })
  status!: FloorStatus;
  @ApiProperty({
    type: TableSessionResponse,
    nullable: true,
    description: 'The open seating or lock, whatever the date asked.',
  })
  session!: TableSessionResponse | null;
  @ApiProperty({
    type: FloorReservationResponse,
    isArray: true,
    description: 'The date’s Confirmed and Checked In bookings.',
  })
  reservations!: FloorReservationResponse[];
  @ApiProperty({
    type: FloorOrderResponse,
    isArray: true,
    description:
      'Bills on the table that are Open or awaiting payment, of any date. ' +
      'A Bartender sees Bar bills only.',
  })
  orders!: FloorOrderResponse[];
}

/** `GET /staff/floor`. */
export class FloorResponse {
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty({ example: 180 }) freeTableReminderMinutes!: number;
  @ApiProperty({ type: FloorTableResponse, isArray: true })
  tables!: FloorTableResponse[];
}
