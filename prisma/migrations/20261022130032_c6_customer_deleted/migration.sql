-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Hand-written below.
--
-- A deleted account (Q36: the customer deletes it from Profile, and it is
-- anonymised) keeps its row, because bookings, bills and the audit log
-- point at it, but holds nothing that identifies the person: no email, no
-- phone, no photo and no address. `DELETE /me` clears them in the same
-- write that sets `deletedAt`; this refuses any write that would leave one
-- behind, or give a deleted account one back.
-- ---------------------------------------------------------------------------
ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_deleted_check" CHECK (
    "deletedAt" IS NULL
    OR (
      "email" IS NULL
      AND "phone" IS NULL
      AND "photo" IS NULL
      AND "addressZone" IS NULL
      AND "addressStreet" IS NULL
      AND "addressArea" IS NULL
      AND "addressTown" IS NULL
      AND "addressLandmark" IS NULL
    )
  );
