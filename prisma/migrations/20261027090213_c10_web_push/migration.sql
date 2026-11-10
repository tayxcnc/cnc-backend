-- C10: web push. Each realm's browser subscriptions, and the queue of
-- pushes written in an event's own transaction and sent after it commits
-- (`PushQueueService`). Only adds: two enums, three tables, their indexes
-- and foreign keys; nothing existing is altered.
--
-- Generated with `prisma migrate diff --from-config-datasource --to-schema
-- prisma/schema.prisma --script` against a database migrated to
-- 20261024191954_c8_order_settled_index, then the CHECK and the partial
-- index appended below the line. Applied to CNC staging by hand with
-- `migrate deploy` before the merge that needs it, on the founder's
-- go-ahead (docs/conventions.md, Data and migrations). It reads and writes
-- nothing of TAY's.

-- CreateEnum
CREATE TYPE "PushMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DROPPED');

-- CreateEnum
CREATE TYPE "PushDropReason" AS ENUM ('NO_DEVICE', 'EXPIRED', 'RECIPIENT_GONE', 'REJECTED', 'GAVE_UP');

-- CreateTable
CREATE TABLE "CustomerPushSubscription" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endpoint" VARCHAR(1024) NOT NULL,
    "p256dh" VARCHAR(128) NOT NULL,
    "auth" VARCHAR(64) NOT NULL,
    "customerId" TEXT NOT NULL,
    "userAgent" VARCHAR(200),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),

    CONSTRAINT "CustomerPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPushSubscription" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endpoint" VARCHAR(1024) NOT NULL,
    "p256dh" VARCHAR(128) NOT NULL,
    "auth" VARCHAR(64) NOT NULL,
    "staffId" TEXT NOT NULL,
    "userAgent" VARCHAR(200),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),

    CONSTRAINT "StaffPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushMessage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT,
    "staffId" TEXT,
    "event" VARCHAR(64) NOT NULL,
    "topic" VARCHAR(200) NOT NULL,
    "dedupeKey" VARCHAR(300) NOT NULL,
    "title" VARCHAR(60) NOT NULL,
    "body" VARCHAR(160) NOT NULL,
    "link" VARCHAR(200),
    "ref" VARCHAR(64),
    "tag" VARCHAR(120) NOT NULL,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "renotify" BOOLEAN NOT NULL DEFAULT false,
    "status" "PushMessageStatus" NOT NULL DEFAULT 'PENDING',
    "dropReason" "PushDropReason",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryAfter" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "PushMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPushSubscription_endpoint_key" ON "CustomerPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "CustomerPushSubscription_customerId_idx" ON "CustomerPushSubscription"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPushSubscription_endpoint_key" ON "StaffPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "StaffPushSubscription_staffId_idx" ON "StaffPushSubscription"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "PushMessage_dedupeKey_key" ON "PushMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "PushMessage_topic_idx" ON "PushMessage"("topic");

-- CreateIndex
CREATE INDEX "PushMessage_customerId_idx" ON "PushMessage"("customerId");

-- CreateIndex
CREATE INDEX "PushMessage_staffId_idx" ON "PushMessage"("staffId");

-- AddForeignKey
ALTER TABLE "CustomerPushSubscription" ADD CONSTRAINT "CustomerPushSubscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPushSubscription" ADD CONSTRAINT "StaffPushSubscription_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushMessage" ADD CONSTRAINT "PushMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushMessage" ADD CONSTRAINT "PushMessage_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written.
-- ---------------------------------------------------------------------------

-- A push is for one person: a customer or a staff member, never both and
-- never nobody. The dedupe key and every dispatch read one owner.
ALTER TABLE "PushMessage"
  ADD CONSTRAINT "PushMessage_one_recipient_check"
  CHECK (num_nonnulls("customerId", "staffId") = 1);

-- The queue's reads: the push sweep and each dispatch look only at open
-- rows (waiting or failed) by when they may next go. Sent and dropped rows,
-- almost the whole table, stay out of the index.
CREATE INDEX "PushMessage_queue_idx" ON "PushMessage"("status", "retryAfter")
  WHERE "status" IN ('PENDING', 'FAILED');
