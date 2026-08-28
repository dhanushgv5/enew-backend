-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'OUT_FOR_DELIVERY';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'DELIVERY_BOY';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryBoyId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE INDEX "orders_deliveryBoyId_idx" ON "orders"("deliveryBoyId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_deliveryBoyId_fkey" FOREIGN KEY ("deliveryBoyId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
