-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN     "retryAfter" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Enquiry_ipHash_createdAt_idx" ON "Enquiry"("ipHash", "createdAt");
