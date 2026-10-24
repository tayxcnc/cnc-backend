import { StockLocation } from '../../generated/cnc-client';
import type { StaffBellItem } from '../reception/free-table-reminder';
import { clockText } from '../reception/reservation-rules';
import { STOCK_LOCATION_LABELS } from '../stock/stock-locations';

/**
 * The staff bell's items that card C8-2 adds (plan §9.1), as pure
 * functions the bell's read maps rows through. Every title, detail and
 * category is the demo's (`staff/lib/notifications.ts`), byte for byte;
 * the ids carry the server's record ids, which the screen only keys on.
 */

/**
 * "Purchase Approval": a requisition awaiting a decision, for managers
 * while the approvals alert is on. The note, or the demo's fallback.
 */
export function purchaseApprovalItem(purchase: {
  id: string;
  number: string;
  note: string;
}): StaffBellItem {
  return {
    id: `purchase:${purchase.id}`,
    title: 'Purchase Approval',
    detail: `${purchase.number} · ${purchase.note || 'Requisition awaiting review'}`,
    page: 'purchasing',
    category: 'Approval',
  };
}

/**
 * "Waste Approval": a Pending write-off, for managers while the approvals
 * alert is on: "W-000004 · 3 Rice · Kitchen".
 */
export function wasteApprovalItem(entry: {
  id: string;
  number: string;
  qty: number;
  itemName: string;
  location: StockLocation;
}): StaffBellItem {
  return {
    id: `waste:${entry.id}`,
    title: 'Waste Approval',
    detail:
      `${entry.number} · ${entry.qty} ${entry.itemName} · ` +
      STOCK_LOCATION_LABELS[entry.location],
    page: 'waste',
    category: 'Approval',
  };
}

/**
 * "Low Stock · Store" or "· Kitchen" or "· Bar": one location of one item
 * below its line (`isLow`), for managers and the Storekeeper while the
 * low-stock alert is on. The Store counts packs ("Rice · 0 bags left"),
 * the Kitchen and the Bar units, with the reorder level ("Rice · 3
 * portions left, reorder level 15"). The plural is the demo's: an "s"
 * unless exactly one.
 */
export function lowStockItem(row: {
  stockItemId: string;
  name: string;
  location: StockLocation;
  qty: number;
  unit: string;
  pack: string;
  minimum: number;
}): StaffBellItem {
  const store = row.location === StockLocation.STORE;
  const word = store ? row.pack : row.unit;

  return {
    id: `low:${row.stockItemId}:${row.location}`,
    title: `Low Stock · ${STOCK_LOCATION_LABELS[row.location]}`,
    detail:
      `${row.name} · ${row.qty} ${word}${row.qty === 1 ? '' : 's'} left` +
      (store ? '' : `, reorder level ${row.minimum}`),
    page: 'inventory',
    category: 'Stock',
  };
}

/**
 * "Unsettled From a Previous Day": an Open or Payment bill dated before
 * today, for managers and the Cashier while the unsettled alert is on.
 */
export function unsettledBillItem(order: {
  id: string;
  number: string;
  label: string;
}): StaffBellItem {
  return {
    id: `unsettled:${order.id}`,
    title: 'Unsettled From a Previous Day',
    detail: `${order.number} · ${order.label}`,
    page: 'pos',
    category: 'Payment',
  };
}

/**
 * "Stock Request": a Kitchen or Bar request still Pending or Partially
 * Issued, for the Storekeeper: "SR-000012 · Kitchen".
 */
export function stockRequestItem(request: {
  id: string;
  number: string;
  location: StockLocation;
}): StaffBellItem {
  return {
    id: `request:${request.id}`,
    title: 'Stock Request',
    detail: `${request.number} · ${STOCK_LOCATION_LABELS[request.location]}`,
    page: 'inventory',
    category: 'Stock',
  };
}

/**
 * "Expected Guest Arrival": a booking Confirmed for today, for Reception
 * and managers while the arrivals alert is on: "Ada · 19:00 · 4 guests"
 * (the demo says "guests" for a party of one too).
 */
export function expectedArrivalItem(booking: {
  id: string;
  name: string;
  startMinutes: number;
  party: number;
}): StaffBellItem {
  return {
    id: `arrival:${booking.id}`,
    title: 'Expected Guest Arrival',
    detail: `${booking.name} · ${clockText(booking.startMinutes)} · ${booking.party} guests`,
    page: 'reception',
    category: 'Reception',
  };
}
