-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "payload" TEXT;
