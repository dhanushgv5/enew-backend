-- Stores the Razorpay refund transaction id once a refund actually goes
-- through (as opposed to just a REFUNDED status label with no real
-- money movement behind it).
-- AlterTable
ALTER TABLE "orders" ADD COLUMN "razorpayRefundId" TEXT;

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN "razorpayRefundId" TEXT;
