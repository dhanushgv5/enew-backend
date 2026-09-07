-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "razorpayOrderId" TEXT,
ADD COLUMN     "razorpayPaymentId" TEXT,
ADD COLUMN     "razorpaySignature" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_razorpayOrderId_key" ON "orders"("razorpayOrderId");
