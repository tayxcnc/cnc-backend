-- C6 review fixes.
--
-- 1. `guestNote`: the guest's own "Anything we should know?", the only note
--    a customer is shown; `note` stays Reception's. `ipHash`: the hashed
--    client address of a website or app booking, for the stored booking caps.

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "guestNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "ipHash" TEXT;

-- CreateIndex
CREATE INDEX "Reservation_ipHash_createdAt_idx" ON "Reservation"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "Reservation_email_createdAt_idx" ON "Reservation"("email", "createdAt");

-- 2. An online booking's note so far was the guest's own text: carry it over.
--    A Reception booking's note is staff's and stays out of `guestNote`.
UPDATE "Reservation"
SET "guestNote" = "note"
WHERE "source" IN ('WEB', 'APP') AND "note" <> '';

-- 3. Q32: no reminder for a booking made less than 24 hours ahead. Before C6
--    nothing wrote `reminderSentAt`, so every booking already made is null,
--    and the first reminders sweep would remind those made late. Stamp them
--    as the booking command now does when it makes one (`initialReminderStamp`:
--    stamped when the start is under 24 hours after the moment it was made),
--    with the moment it was made. The start is the date and arrival in Jos
--    (WAT), compared in UTC as `createdAt` is stored.
UPDATE "Reservation"
SET "reminderSentAt" = "createdAt"
WHERE "reminderSentAt" IS NULL
  AND "status" = 'CONFIRMED'
  AND (
    ("businessDate"::timestamp + make_interval(mins => "startMinutes"))
      AT TIME ZONE 'Africa/Lagos' AT TIME ZONE 'UTC'
  ) - interval '24 hours' < "createdAt";
