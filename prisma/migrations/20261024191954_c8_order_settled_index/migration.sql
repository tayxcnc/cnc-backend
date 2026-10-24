-- CreateIndex
CREATE INDEX "Order_status_settledAt_idx" ON "Order"("status", "settledAt");
