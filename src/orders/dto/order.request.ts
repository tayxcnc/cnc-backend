import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, ValidateIf } from 'class-validator';
import { Department } from '../../../generated/cnc-client';
import { Checked, requiredText } from '../../common/checked';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import {
  DEPARTMENT_MESSAGE,
  ITEM_UNAVAILABLE_MESSAGE,
  MAX_LINE_QTY,
  ORDER_GUEST_MAX_LENGTH,
  ORDER_LABEL_MAX_LENGTH,
  ORDER_NOTES_MAX_LENGTH,
  QTY_MAX_MESSAGE,
  QTY_WHOLE_MESSAGE,
  TABLE_MESSAGE,
} from '../order-messages';

/**
 * Each field answers one sentence at most (`Checked`, `OptionalText`): the
 * staff app joins every message of a 400 into what the screen shows, and
 * the demo's sentence must show once, as it stands (A7).
 */

/** Longest option text accepted; every seeded option is far shorter. */
const OPTION_MAX_LENGTH = 120;

/** Longest id accepted where a cuid is expected. */
const ID_MAX_LENGTH = 64;

/** Body of `POST /staff/orders`: `order.create`. */
export class CreateOrderRequest {
  @ApiProperty({
    enum: Department,
    enumName: 'Department',
    description:
      'Restaurant (`CNCR-`) or Bar (`CNCB-`). A Bartender opens Bar orders only.',
  })
  @IsEnum(Department, { message: DEPARTMENT_MESSAGE })
  department!: Department;

  @ApiPropertyOptional({
    description:
      'DiningTable.id. Blank or absent for an order with no table (takeaway ' +
      'or a walk-up drink).',
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @Checked((value) =>
    typeof value === 'string' && value.length <= ID_MAX_LENGTH
      ? null
      : TABLE_MESSAGE,
  )
  tableId?: string;

  @ApiPropertyOptional({
    description:
      'What the till shows for the order. When blank: the table’s name, ' +
      'or "Order <n>" from the order number.',
    maxLength: ORDER_LABEL_MAX_LENGTH,
    example: 'Window seat',
  })
  @OptionalText('label', ORDER_LABEL_MAX_LENGTH)
  label?: string;

  @ApiPropertyOptional({
    description: 'The guest’s name, if given.',
    maxLength: ORDER_GUEST_MAX_LENGTH,
  })
  @OptionalText('guest', ORDER_GUEST_MAX_LENGTH)
  guest?: string;
}

/**
 * Body of `PUT /staff/orders/:id/lines`: `order.quantity`, one line set to
 * an absolute quantity. A line is a dish plus its option; zero removes it.
 */
export class SetOrderLineRequest extends VersionedWriteDto {
  @ApiProperty({
    description: 'MenuItem.id, a dish of the order’s department.',
  })
  @Checked(
    requiredText(
      ITEM_UNAVAILABLE_MESSAGE,
      ID_MAX_LENGTH,
      ITEM_UNAVAILABLE_MESSAGE,
    ),
  )
  menuItemId!: string;

  @ApiPropertyOptional({
    description:
      'One of the dish’s choice options, required when it has a choice ' +
      'and refused when it has none. Absent or blank for no option.',
    maxLength: OPTION_MAX_LENGTH,
    example: 'Suya beef',
  })
  @OptionalText('option', OPTION_MAX_LENGTH)
  option?: string;

  @ApiProperty({
    description:
      'The line’s new quantity, 0 to 999. Zero removes the line. A new ' +
      'line takes the dish’s current price; an existing line keeps the ' +
      'price it was added at.',
    minimum: 0,
    maximum: MAX_LINE_QTY,
    example: 2,
  })
  @Checked((value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return QTY_WHOLE_MESSAGE;
    }

    return value > MAX_LINE_QTY ? QTY_MAX_MESSAGE : null;
  })
  qty!: number;
}

/**
 * Body of `PATCH /staff/orders/:id`: `order.details`, the guest's name and
 * the order notes (which print on the next docket). Only the fields sent
 * change.
 */
export class UpdateOrderDetailsRequest extends VersionedWriteDto {
  @ApiPropertyOptional({ maxLength: ORDER_GUEST_MAX_LENGTH })
  @OptionalText('guest', ORDER_GUEST_MAX_LENGTH)
  guest?: string;

  @ApiPropertyOptional({
    description: 'Notes for the kitchen; printed on the next docket revision.',
    maxLength: ORDER_NOTES_MAX_LENGTH,
  })
  @OptionalText('notes', ORDER_NOTES_MAX_LENGTH)
  notes?: string;
}

/** Body of `POST /staff/orders/:id/confirm`: `order.confirm`. */
export class ConfirmOrderRequest extends VersionedWriteDto {}

/** Which bills a till list shows. */
export enum OrderListState {
  /** Open or awaiting payment: the till's working list. */
  ACTIVE = 'ACTIVE',
  SETTLED = 'SETTLED',
  CANCELLED = 'CANCELLED',
  ALL = 'ALL',
}

/** The till's filter chips (the demo's `fits`), within the state asked for. */
export enum OrderListFilter {
  ALL = 'ALL',
  /** Open: still taking items. */
  UNSETTLED = 'UNSETTLED',
  /** At Payment with nothing paid yet. */
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  /** Something already paid. */
  PART_PAID = 'PART_PAID',
  /** Opened on an earlier business date. */
  PREVIOUS_DAYS = 'PREVIOUS_DAYS',
}

/** `GET /staff/orders`. */
export class OrderListQuery extends PaginationQuery {
  @ApiProperty({
    enum: Department,
    enumName: 'Department',
    description: 'Required. A Bartender reads the Bar only.',
  })
  @IsEnum(Department, { message: DEPARTMENT_MESSAGE })
  department!: Department;

  @ApiPropertyOptional({
    enum: OrderListState,
    enumName: 'OrderListState',
    default: OrderListState.ACTIVE,
  })
  @ValidateIf(isSent)
  @IsIn(Object.values(OrderListState), {
    message: 'state must be ACTIVE, SETTLED, CANCELLED or ALL.',
  })
  state?: OrderListState;

  @ApiPropertyOptional({
    enum: OrderListFilter,
    enumName: 'OrderListFilter',
    default: OrderListFilter.ALL,
  })
  @ValidateIf(isSent)
  @IsIn(Object.values(OrderListFilter), {
    message:
      'filter must be ALL, UNSETTLED, AWAITING_PAYMENT, PART_PAID or PREVIOUS_DAYS.',
  })
  filter?: OrderListFilter;

  @ApiPropertyOptional({
    description: 'DiningTable.id: that table’s bills only.',
  })
  @OptionalText('tableId', ID_MAX_LENGTH)
  tableId?: string;

  @ApiPropertyOptional({
    description: 'Part of the order number, label or guest name, any case.',
  })
  @OptionalText('q', 120)
  q?: string;
}
