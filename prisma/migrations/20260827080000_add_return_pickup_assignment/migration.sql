-- AlterTable
ALTER TABLE "return_requests"
  ADD COLUMN "pickupDate" TIMESTAMP(3),
  ADD COLUMN "deliveryBoyId" TEXT;

-- CreateIndex
CREATE INDEX "return_requests_deliveryBoyId_idx" ON "return_requests"("deliveryBoyId");

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_deliveryBoyId_fkey" FOREIGN KEY ("deliveryBoyId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
