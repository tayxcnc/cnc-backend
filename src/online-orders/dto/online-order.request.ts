import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import {
  OnlineFulfilmentStatus,
  OnlineOrderMode,
} from '../../../generated/cnc-client';
import { AdminReason } from '../../common/admin-reason';
import { Checked } from '../../common/checked';
import {
  LINES_EMPTY_MESSAGE,
  LINES_QTY_MESSAGE,
  ValidLines,
} from '../../common/command-lines';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import { customerPhone, PHONE_MESSAGE } from '../../customers/profile-rules';
import { CHECKOUT_NOTE_MAX_LENGTH } from '../../ordering/dto/checkout.dto';
import { PAYMENT_TEXT_MAX_LENGTH } from '../../orders/order-messages';
import {
  BALANCE_METHOD_MESSAGE,
  DELIVERY_ADDRESS_MESSAGE,
  EDIT_MENU_ITEM_MESSAGE,
  INVALID_FULFILMENT_STATUS_MESSAGE,
  INVALID_ZONE_MESSAGE,
  NEXT_STAGE_MESSAGE,
  ONLINE_CONTACT_NAME_MAX_LENGTH,
} from '../online-order-messages';

/** The Online Orders screen's two tabs (`GET /staff/online-orders`). */
export enum OnlineOrderTab {
  /** Received, Preparing, Out for Delivery or Ready for Pickup. */
  ACTIVE = 'ACTIVE',
  /** Delivered, Collected or Cancelled. */
  HISTORY = 'HISTORY',
}

/** Longest search text accepted. */
const SEARCH_MAX_LENGTH = 80;

/** `GET /staff/online-orders`. */
export class OnlineOrderListQuery extends PaginationQuery {
  @ApiPropertyOptional({
    enum: OnlineOrderTab,
    enumName: 'OnlineOrderTab',
    default: OnlineOrderTab.ACTIVE,
  })
  @ValidateIf(isSent)
  @Checked((value) =>
    (Object.values(OnlineOrderTab) as unknown[]).includes(value)
      ? null
      : 'tab must be ACTIVE or HISTORY.',
  )
  tab?: OnlineOrderTab;

  @ApiPropertyOptional({
    description:
      'Part of the WEB- or CNCR- number, the guest’s name or phone, any case.',
  })
  @OptionalText('q', SEARCH_MAX_LENGTH)
  q?: string;
}

/** Body of `POST /staff/online-orders/:id/status`: `online.status`. */
export class OnlineStatusRequest extends VersionedWriteDto {
  @ApiProperty({
    enum: OnlineFulfilmentStatus,
    enumName: 'OnlineFulfilmentStatus',
    description:
      'The order’s current stage or the next one on its path: RECEIVED, ' +
      'PREPARING, then ON_THE_WAY (delivery) or READY (pickup), then ' +
      'DELIVERED (delivery) or COLLECTED (pickup).',
  })
  @Checked((value) => (typeof value === 'string' ? null : NEXT_STAGE_MESSAGE))
  status!: OnlineFulfilmentStatus;
}

const CORRECTABLE_STATUSES: readonly unknown[] = Object.values(
  OnlineFulfilmentStatus,
).filter((status) => status !== OnlineFulfilmentStatus.CANCELLED);

/** Body of `POST /staff/online-orders/:id/correct-status`. */
export class OnlineCorrectStatusRequest extends VersionedWriteDto {
  @ApiProperty({
    enum: OnlineFulfilmentStatus,
    enumName: 'OnlineFulfilmentStatus',
    description:
      'Any stage on the order’s own path, earlier ones included; never ' +
      'CANCELLED (that is `online.cancel`).',
  })
  @Checked((value) =>
    CORRECTABLE_STATUSES.includes(value)
      ? null
      : INVALID_FULFILMENT_STATUS_MESSAGE,
  )
  status!: OnlineFulfilmentStatus;

  @AdminReason('Why the stage is corrected.')
  reason!: string;
}

/** One line of an edited web order: a dish, its choice, how many. */
export class OnlineEditLineRequest {
  @ApiProperty({ description: 'MenuItem.id: a Restaurant or a Bar item.' })
  menuItemId!: string;

  @ApiPropertyOptional({
    description: 'One of the dish’s options; omitted for a dish without one.',
  })
  option?: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 999 })
  qty!: number;
}

/** The demo's `positiveLines` over an edit's lines, keyed by dish and option. */
const EDIT_LINES = {
  idKey: 'menuItemId',
  idMessage: EDIT_MENU_ITEM_MESSAGE,
  qtyKey: 'qty',
  minQty: 1,
  qtyMessage: LINES_QTY_MESSAGE,
  emptyMessage: LINES_EMPTY_MESSAGE,
  lineKey: (line: Record<string, unknown>) =>
    `${String(line.menuItemId)}|${typeof line.option === 'string' ? line.option : ''}`,
} as const;

/**
 * Body of `POST /staff/online-orders/:id/edit`: `online.edit`. The whole
 * new list of lines; the guest's name, phone and the note change only when
 * sent (a blank name or phone keeps the one held, as the demo's
 * `c.name?.trim() || w.name`). The address is the delivery details'
 * (`online.zone`).
 */
export class OnlineEditRequest extends VersionedWriteDto {
  @ApiProperty({ type: OnlineEditLineRequest, isArray: true })
  @ValidLines(EDIT_LINES)
  lines!: OnlineEditLineRequest[];

  @ApiPropertyOptional({ maxLength: ONLINE_CONTACT_NAME_MAX_LENGTH })
  @OptionalText('contactName', ONLINE_CONTACT_NAME_MAX_LENGTH)
  contactName?: string;

  @ApiPropertyOptional({ example: '0803 123 4567' })
  @ValidateIf(isSent)
  @Checked((value) =>
    customerPhone(value) === undefined ? PHONE_MESSAGE : null,
  )
  contactPhone?: string;

  @ApiPropertyOptional({
    maxLength: CHECKOUT_NOTE_MAX_LENGTH,
    description: 'Kitchen instructions or substitutions; `""` clears it.',
  })
  @OptionalText('note', CHECKOUT_NOTE_MAX_LENGTH)
  note?: string;

  @AdminReason('Why the paid order is changed.')
  reason!: string;
}

/** Body of `POST /staff/online-orders/:id/cancel`: `online.cancel`. */
export class OnlineCancelRequest extends VersionedWriteDto {
  @AdminReason('Why the paid order is cancelled.')
  reason!: string;
}

/** A delivery address without its zone: the mode names the zone. */
export class OnlineAddressRequest {
  @ApiProperty({ example: '12 Rayfield Road' }) street!: string;
  @ApiProperty({ example: 'Rayfield' }) area!: string;
  @ApiProperty({ example: 'Jos' }) town!: string;
  @ApiProperty({ example: 'Opposite the filling station' }) landmark!: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Body of `POST /staff/online-orders/:id/zone`: `online.zone`. */
export class OnlineZoneRequest extends VersionedWriteDto {
  @ApiProperty({ enum: OnlineOrderMode, enumName: 'OnlineOrderMode' })
  @Checked((value) =>
    (Object.values(OnlineOrderMode) as unknown[]).includes(value)
      ? null
      : INVALID_ZONE_MESSAGE,
  )
  mode!: OnlineOrderMode;

  @ApiPropertyOptional({
    type: OnlineAddressRequest,
    description:
      'For a delivery: the address, the website checkout’s four lines with ' +
      'the landmark required. Omitted, a delivery keeps the address it ' +
      'holds. Ignored for `PICKUP`, which clears the address.',
  })
  @ValidateIf(isSent)
  @Checked((value) => (isRecord(value) ? null : DELIVERY_ADDRESS_MESSAGE))
  address?: OnlineAddressRequest;

  @AdminReason('Why the delivery details change.')
  reason!: string;
}

/**
 * How `online.balance` moves the money (Q26, Q34): Cash or Transfer
 * recorded by staff, either way; or, for a refund only, back to the card
 * through Paystack's refund API.
 */
export enum OnlineBalanceMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  PAYSTACK = 'PAYSTACK',
}

/** Body of `POST /staff/online-orders/:id/balance`: `online.balance`. */
export class OnlineBalanceRequest extends VersionedWriteDto {
  @ApiProperty({
    enum: OnlineBalanceMethod,
    enumName: 'OnlineBalanceMethod',
    description:
      'CASH or TRANSFER record money staff took or gave back; PAYSTACK ' +
      'sends a refund to the card that paid (refunds only).',
  })
  @Checked((value) =>
    (Object.values(OnlineBalanceMethod) as unknown[]).includes(value)
      ? null
      : BALANCE_METHOD_MESSAGE,
  )
  method!: OnlineBalanceMethod;

  @ApiPropertyOptional({
    description: 'The sender or recipient; required for a transfer.',
    maxLength: PAYMENT_TEXT_MAX_LENGTH,
  })
  @OptionalText('sender', PAYMENT_TEXT_MAX_LENGTH)
  sender?: string;

  @ApiPropertyOptional({
    description: 'The transfer’s reference; required for a transfer.',
    maxLength: PAYMENT_TEXT_MAX_LENGTH,
  })
  @OptionalText('reference', PAYMENT_TEXT_MAX_LENGTH)
  reference?: string;

  @AdminReason('Why the money is recorded or returned.')
  reason!: string;
}
