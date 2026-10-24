-- C8-3: rate limits that every Cloud Run instance counts against together.
-- The in-memory throttler counts (plan A18) were per instance; these rows
-- are written by `RateLimitStore.hit`, one atomic upsert per request, and
-- deleted by the tokens sweep once their window and block have ended.
--
-- Created with `migrate dev --create-only` against the local cnc_db, then
-- the CHECK appended below the line. Applied to CNC staging by hand with
-- `migrate deploy` before the merge that needs it, on the founder's
-- go-ahead (docs/conventions.md, Data and migrations). It reads and writes
-- nothing of TAY's.

-- CreateTable
CREATE TABLE "RateLimitCount" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),

    CONSTRAINT "RateLimitCount_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimitCount_windowEndsAt_idx" ON "RateLimitCount"("windowEndsAt");

-- ---------------------------------------------------------------------------
-- Hand-written.
-- ---------------------------------------------------------------------------

-- A row exists only because a request was counted.
ALTER TABLE "RateLimitCount"
  ADD CONSTRAINT "RateLimitCount_hits_check" CHECK ("hits" >= 1);
