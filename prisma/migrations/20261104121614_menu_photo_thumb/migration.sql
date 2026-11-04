-- Menu photo thumbnails (batch 2 B2; platform fixes plan, wave 5, PR 31).
--
-- One nullable column and nothing else: every existing row reads null, so
-- the code before this change and the code after it both run against the
-- migrated table. A photo uploaded from now on gets its thumbnail at
-- upload; a photo already stored gets one from
-- `npm run media:backfill-thumbs`, run once after the deploy.

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "photoThumb" TEXT;
