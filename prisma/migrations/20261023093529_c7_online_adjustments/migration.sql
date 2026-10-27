-- C7-4: the staff Online Orders commands. Both zones' delivery fees
-- snapshotted on the checkout and the online order (Q27), the online
-- adjustments and the card refunds, and the Bar's web-sale return.

-- CreateEnum
CREATE TYPE "OnlineRefundStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'REFUSED', 'UNCONFIRMED');

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'WEB_SALE_RETURN';

-- AlterTable: added nullable, filled, then required (hand-edited: Prisma
-- adds a required column without a value, which fails on a table that has
-- rows). A checkout made before this migration takes the fees Settings
-- holds now; an online order takes its checkout's.
ALTER TABLE "Checkout" ADD COLUMN     "deliveryJosKobo" INTEGER,
ADD COLUMN     "deliveryOutsideKobo" INTEGER;

UPDATE "Checkout"
   SET "deliveryJosKobo" = s."deliveryJosKobo",
       "deliveryOutsideKobo" = s."deliveryOutsideKobo"
  FROM "Settings" s
 WHERE s."singleton" = true;

-- A database with checkouts and no settings row cannot exist (the checkout
-- reads the row); the zone's own fee is the fallback all the same.
UPDATE "Checkout"
   SET "deliveryJosKobo" = COALESCE("deliveryJosKobo", "deliveryKobo"),
       "deliveryOutsideKobo" = COALESCE("deliveryOutsideKobo", "deliveryKobo");

ALTER TABLE "Checkout" ALTER COLUMN "deliveryJosKobo" SET NOT NULL,
ALTER COLUMN "deliveryOutsideKobo" SET NOT NULL;

-- AlterTable (as above)
ALTER TABLE "OnlineOrder" ADD COLUMN     "deliveryJosKobo" INTEGER,
ADD COLUMN     "deliveryOutsideKobo" INTEGER;

UPDATE "OnlineOrder" o
   SET "deliveryJosKobo" = c."deliveryJosKobo",
       "deliveryOutsideKobo" = c."deliveryOutsideKobo"
  FROM "Checkout" c
 WHERE c."id" = o."checkoutId";

ALTER TABLE "OnlineOrder" ALTER COLUMN "deliveryJosKobo" SET NOT NULL,
ALTER COLUMN "deliveryOutsideKobo" SET NOT NULL;

-- CreateTable
CREATE TABLE "OnlineAdjustment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "onlineOrderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3),
    "settledPaymentId" TEXT,

    CONSTRAINT "OnlineAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnlineRefund" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "onlineOrderId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "transactionReference" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "status" "OnlineRefundStatus" NOT NULL DEFAULT 'PENDING',
    "providerRefundId" TEXT,
    "providerStatus" TEXT,
    "providerMessage" TEXT,
    "staffId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "OnlineRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnlineAdjustment_onlineOrderId_settledAt_idx" ON "OnlineAdjustment"("onlineOrderId", "settledAt");

-- CreateIndex
CREATE INDEX "OnlineAdjustment_settledPaymentId_idx" ON "OnlineAdjustment"("settledPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineRefund_paymentId_key" ON "OnlineRefund"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineRefund_providerRefundId_key" ON "OnlineRefund"("providerRefundId");

-- CreateIndex
CREATE INDEX "OnlineRefund_onlineOrderId_idx" ON "OnlineRefund"("onlineOrderId");

-- CreateIndex
CREATE INDEX "OnlineRefund_status_createdAt_idx" ON "OnlineRefund"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "OnlineAdjustment" ADD CONSTRAINT "OnlineAdjustment_onlineOrderId_fkey" FOREIGN KEY ("onlineOrderId") REFERENCES "OnlineOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineAdjustment" ADD CONSTRAINT "OnlineAdjustment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineAdjustment" ADD CONSTRAINT "OnlineAdjustment_settledPaymentId_fkey" FOREIGN KEY ("settledPaymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineRefund" ADD CONSTRAINT "OnlineRefund_onlineOrderId_fkey" FOREIGN KEY ("onlineOrderId") REFERENCES "OnlineOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineRefund" ADD CONSTRAINT "OnlineRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineRefund" ADD CONSTRAINT "OnlineRefund_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below: what Prisma cannot express.
-- ===========================================================================

-- Both zones' fees are money and never negative, on the checkout and on the
-- online order (Q27 prices a zone change from them).
ALTER TABLE "Checkout"
  ADD CONSTRAINT "Checkout_zone_fees_check"
  CHECK ("deliveryJosKobo" >= 0 AND "deliveryOutsideKobo" >= 0);

ALTER TABLE "OnlineOrder"
  ADD CONSTRAINT "OnlineOrder_zone_fees_check"
  CHECK ("deliveryJosKobo" >= 0 AND "deliveryOutsideKobo" >= 0);

-- An adjustment moves the order's worth by something (a change worth
-- nothing makes none), names the command that made it, carries its reason,
-- and is settled by a payment only when it is settled at all.
ALTER TABLE "OnlineAdjustment"
  ADD CONSTRAINT "OnlineAdjustment_values_check" CHECK (
    "amountKobo" <> 0
    AND "action" IN ('online.edit', 'online.cancel', 'online.zone')
    AND btrim("reason") <> ''
    AND ("settledPaymentId" IS NULL OR "settledAt" IS NOT NULL)
  );

-- A refund returns money (positive here; its payment row is negative),
-- Paystack's refund id comes with its acceptance, and a refund sent or
-- answered records when it went.
ALTER TABLE "OnlineRefund"
  ADD CONSTRAINT "OnlineRefund_values_check" CHECK (
    "amountKobo" > 0
    AND ("status" <> 'SENT' OR "providerRefundId" IS NOT NULL)
    AND (("status" IN ('PENDING', 'SENDING')) = ("sentAt" IS NULL))
  );
