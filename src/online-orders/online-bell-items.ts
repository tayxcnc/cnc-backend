import type { OnlineFulfilmentStatus } from '../../generated/cnc-client';
import { formatKobo } from '../common/money';
import { watMinutesOfDay, watToday } from '../common/wat';
import type { StaffBellItem } from '../reception/free-table-reminder';
import { bookingDateText, clockText } from '../reception/reservation-rules';
import { STAFF_ONLINE_STATUS_LABELS } from './online-order-rules';

/**
 * The online orders' staff bell items (plan §7.4 step 5, §9.1; card
 * C7-7), as pure functions the bell's read maps rows through.
 */

/**
 * The Cashier's item for an active online order, in the demo's words
 * (`staff/lib/notifications.ts`): "Online Order · Paid", the bill's number
 * and the guest's name, on Online Orders. A paid web order appears here
 * the moment the payment writes it, and leaves once completed or
 * cancelled.
 */
export function activeOnlineOrderItem(online: {
  id: string;
  orderNumber: string;
  contactName: string;
  fulfilmentStatus: OnlineFulfilmentStatus;
}): StaffBellItem {
  return {
    id: `online:${online.id}`,
    title: `Online Order · ${STAFF_ONLINE_STATUS_LABELS[online.fulfilmentStatus]}`,
    detail: `${online.orderNumber} · ${online.contactName}`,
    page: 'online',
    category: 'Fulfilment',
  };
}

/** When a web docket is for, in words: "As soon as possible" or its time. */
export function docketTimingText(scheduledFor: Date | null): string {
  return scheduledFor === null
    ? 'As soon as possible'
    : `${bookingDateText(watToday(scheduledFor))} at ` +
        clockText(watMinutesOfDay(scheduledFor));
}

/**
 * The Kitchen's and the managers' "New Web Docket" (plan §9.1, new): a
 * web docket with food the kitchen has not entered yet, with its `KOT-`
 * ref and when it is for, opening Kitchen with the ref filled in (`ref`).
 * The id carries the revision, so an edited order's reprint is a new item.
 */
export function newWebDocketItem(docket: {
  ref: string;
  revision: number;
  scheduledFor: Date | null;
}): StaffBellItem {
  return {
    id: `docket:${docket.ref}:${docket.revision}`,
    title: 'New Web Docket',
    detail: `${docket.ref} · ${docketTimingText(docket.scheduledFor)}`,
    page: 'kitchen',
    category: 'Kitchen',
    ref: docket.ref,
  };
}

/**
 * The managers' "Checkout Needs Attention" (plan §7.4 step 3, §9.1, new):
 * a signed payment that did not match its checkout, so no order was made.
 * The customer's name, the checkout's total and the reason, on Online
 * Orders, with the checkout's id as `ref` for
 * `POST /staff/online-orders/checkouts/:checkoutId/resolve`; the item
 * leaves the bell once that resolves it.
 */
export function checkoutAttentionItem(checkout: {
  id: string;
  contactName: string;
  totalKobo: number;
  attentionReason: string | null;
}): StaffBellItem {
  return {
    id: `attention:${checkout.id}`,
    title: 'Checkout Needs Attention',
    detail: [
      checkout.contactName,
      formatKobo(checkout.totalKobo),
      checkout.attentionReason ?? 'The payment does not match the checkout.',
    ].join(' · '),
    page: 'online',
    category: 'Payment',
    // The checkout a manager resolves once it is dealt with in Paystack.
    ref: checkout.id,
  };
}
