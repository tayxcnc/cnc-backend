-- C8-0: a refused card refund no longer counts toward the Daily Approval
-- Limit (the founder's decision of 2026-10-24). The ledger stays
-- append-only: a release row names the row it gives back (`releasesId`),
-- and a card refund names the row that counted it (`ledgerEntryId`).
--
-- Generated from `prisma migrate diff --from-config-datasource --to-schema
-- prisma/schema.prisma --script` against the local cnc_db (`migrate dev
-- --create-only` refuses to run without a terminal when it warns about the
-- new unique indexes), then the hand-written part appended below the line.
-- The same diff prints an empty migration once this is applied.
--
-- Applied to CNC staging by hand with `migrate deploy` before the merge that
-- needs it, on the founder's go-ahead (docs/conventions.md, Data and
-- migrations). It reads and writes nothing of TAY's.

-- AlterTable
ALTER TABLE "ApprovalLedger" ADD COLUMN     "releasesId" TEXT;

-- AlterTable
ALTER TABLE "OnlineRefund" ADD COLUMN     "ledgerEntryId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLedger_releasesId_key" ON "ApprovalLedger"("releasesId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineRefund_ledgerEntryId_key" ON "OnlineRefund"("ledgerEntryId");

-- AddForeignKey
ALTER TABLE "ApprovalLedger" ADD CONSTRAINT "ApprovalLedger_releasesId_fkey" FOREIGN KEY ("releasesId") REFERENCES "ApprovalLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineRefund" ADD CONSTRAINT "OnlineRefund_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "ApprovalLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below: what Prisma cannot express.
-- ===========================================================================

-- A counted row is positive, as before; only a release row, which names the
-- row it gives back, is negative. A zero still counts nothing and is refused
-- either way, so no row can lower a manager's day except a release.
ALTER TABLE "ApprovalLedger" DROP CONSTRAINT "ApprovalLedger_amount_check";

ALTER TABLE "ApprovalLedger"
  ADD CONSTRAINT "ApprovalLedger_amount_check" CHECK (
    ("releasesId" IS NULL AND "amountKobo" > 0)
    OR ("releasesId" IS NOT NULL AND "amountKobo" < 0)
  );

-- A release gives back part or all of one counted row, on that row's own
-- person, business date and ref, and never more than it counted. A CHECK
-- cannot read another row, so a trigger holds the shape; the unique index on
-- "releasesId" already stops a second release of the same row. Releasing a
-- release is refused, so a release can never be cancelled out.
CREATE FUNCTION "approval_ledger_release_shape"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  released "ApprovalLedger"%ROWTYPE;
BEGIN
  IF NEW."releasesId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO released FROM "ApprovalLedger" WHERE "id" = NEW."releasesId";

  IF NOT FOUND
     OR released."releasesId" IS NOT NULL
     OR released."staffId" <> NEW."staffId"
     OR released."businessDate" <> NEW."businessDate"
     OR released."ref" IS DISTINCT FROM NEW."ref"
     OR -NEW."amountKobo" > released."amountKobo" THEN
    RAISE EXCEPTION 'ApprovalLedger release does not match the row it releases'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ApprovalLedger_release_shape"
  BEFORE INSERT ON "ApprovalLedger"
  FOR EACH ROW EXECUTE FUNCTION "approval_ledger_release_shape"();
