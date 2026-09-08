-- Prevents the same Razorpay payment ID from ever being attached to two
-- different orders, even if a future code path had a bug that let it try.
-- CreateIndex
CREATE UNIQUE INDEX "orders_razorpayPaymentId_key" ON "orders"("razorpayPaymentId");
