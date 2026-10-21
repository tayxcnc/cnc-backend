/**
 * The Free Table Reminder (plan §7.5, §9.1; D37): a table where guests
 * have been seated for at least `Settings.freeTableReminderMinutes` (180
 * by default, 15 to 1440) appears on Reception's and the managers' bell,
 * asking whether they have left. Nothing frees a table by itself (D20):
 * the reminder only asks.
 */

const MINUTE_MS = 60 * 1000;

/** Whether an Occupied session seated at `since` is due a reminder at `now`. */
export function isReminderDue(
  since: Date,
  now: Date,
  reminderMinutes: number,
): boolean {
  return now.getTime() - since.getTime() >= reminderMinutes * MINUTE_MS;
}

/**
 * How long guests have been seated, in words (D37): minutes under an hour,
 * whole hours after. The demo said "a while" under an hour and "0 hours"
 * never, but a reminder set to 15 minutes would have read "seated a while
 * ago" for its first three quarters of an hour.
 */
export function seatedForText(since: Date, now: Date): string {
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - since.getTime()) / MINUTE_MS),
  );

  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

  const hours = Math.floor(minutes / 60);

  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** A staff bell item (plan §9.1): `page` is always one the recipient can open. */
export interface StaffBellItem {
  id: string;
  title: string;
  detail: string;
  page: string;
  category: string;
}

/**
 * The demo's Free Table Reminder item, in its words: "Booth 1 · Ada
 * seated 3 hours ago. Free it if they have left." The id names the table
 * and the seating, so a reseated table is a new item.
 */
export function freeTableReminderItem(
  session: { tableId: string; tableName: string; guest: string; since: Date },
  now: Date,
): StaffBellItem {
  return {
    id: `free:${session.tableId}:${session.since.toISOString()}`,
    title: 'Free Table Reminder',
    detail:
      `${session.tableName} · ${session.guest || 'Guests'} seated ` +
      `${seatedForText(session.since, now)} ago. Free it if they have left.`,
    page: 'reception',
    category: 'Reception',
  };
}
