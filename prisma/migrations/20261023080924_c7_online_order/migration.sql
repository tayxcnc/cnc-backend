-- CreateEnum
CREATE TYPE "OnlineOrderMode" AS ENUM ('PICKUP', 'WITHIN_JOS', 'OUTSIDE_JOS');

-- CreateEnum
CREATE TYPE "OnlineFulfilmentStatus" AS ENUM ('RECEIVED', 'PREPARING', 'ON_THE_WAY', 'READY', 'DELIVERED', 'COLLECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "OnlineOrder" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "customerId" TEXT,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "mode" "OnlineOrderMode" NOT NULL,
    "addressStreet" TEXT,
    "addressArea" TEXT,
    "addressTown" TEXT,
    "addressLandmark" TEXT,
    "addressText" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "feeKobo" INTEGER NOT NULL,
    "timingText" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "fulfilmentStatus" "OnlineFulfilmentStatus" NOT NULL DEFAULT 'RECEIVED',
    "paystackReference" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OnlineOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrder_number_key" ON "OnlineOrder"("number");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrder_orderId_key" ON "OnlineOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrder_checkoutId_key" ON "OnlineOrder"("checkoutId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrder_paystackReference_key" ON "OnlineOrder"("paystackReference");

-- CreateIndex
CREATE INDEX "OnlineOrder_fulfilmentStatus_createdAt_idx" ON "OnlineOrder"("fulfilmentStatus", "createdAt");

-- CreateIndex
CREATE INDEX "OnlineOrder_customerId_idx" ON "OnlineOrder"("customerId");

-- AddForeignKey
ALTER TABLE "OnlineOrder" ADD CONSTRAINT "OnlineOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineOrder" ADD CONSTRAINT "OnlineOrder_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "Checkout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineOrder" ADD CONSTRAINT "OnlineOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written below: what Prisma cannot express.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A checkout is PAID exactly when its order exists (C7-3): the order, the
-- online order, the payment, the docket and the Bar movements are written in
-- the transaction that marks it paid, so a paid checkout without an order is
-- a payment nobody will cook, and an order on an unpaid checkout is food
-- given away.
-- ---------------------------------------------------------------------------
ALTER TABLE "Checkout"
  ADD CONSTRAINT "Checkout_order_check"
  CHECK (("status" = 'PAID') = ("orderId" IS NOT NULL));

-- The delivery fee is a separate line (Q21) and never negative; pickup
-- carries no address (the lines are cleared when an order moves to pickup,
-- C7-4, and when a customer deletes their account, Q36).
ALTER TABLE "OnlineOrder"
  ADD CONSTRAINT "OnlineOrder_fee_check" CHECK ("feeKobo" >= 0);

ALTER TABLE "OnlineOrder"
  ADD CONSTRAINT "OnlineOrder_pickup_check" CHECK (
    "mode" <> 'PICKUP'
    OR (
      "addressStreet" IS NULL
      AND "addressArea" IS NULL
      AND "addressTown" IS NULL
      AND "addressLandmark" IS NULL
      AND "addressText" = ''
    )
  );

-- The phone as CNC stores one (`0` plus 10 digits) and the email lower case,
-- or both empty once the customer deleted their account (Q36), as on the
-- checkout.
ALTER TABLE "OnlineOrder"
  ADD CONSTRAINT "OnlineOrder_contact_check" CHECK (
    ("contactPhone" ~ '^0[0-9]{10}$' OR "contactPhone" = '')
    AND "contactEmail" = lower("contactEmail")
  );

-- The number the sequence prints (`WEB-` and at least 6 digits).
ALTER TABLE "OnlineOrder"
  ADD CONSTRAINT "OnlineOrder_number_check"
  CHECK ("number" ~ '^WEB-[0-9]{6,}$');
