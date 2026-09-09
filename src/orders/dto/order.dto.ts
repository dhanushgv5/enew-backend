import { IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateOrderDto {
  @IsObject()
  shippingAddress: {
    firstName: string;
    lastName: string;
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
  };

  @IsOptional()
  @IsObject()
  billingAddress?: Record<string, any>;
}

export class UpdateOrderStatusDto {
  @IsString()
  status: string;

  @IsOptional()
  @IsString()
  note?: string;

  // Only meaningful when status === REFUNDED - amount in rupees to actually
  // refund via Razorpay. Defaults to the full order total if omitted.
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  refundAmount?: number;
}

// Same shape as CreateOrderDto.shippingAddress - used when a customer
// edits the address on an order they've already placed.
export class UpdateOrderAddressDto {
  @IsObject()
  shippingAddress: {
    firstName: string;
    lastName: string;
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
  };
}

export class AssignDeliveryDto {
  @IsUUID()
  deliveryBoyId: string;
}

export class UpdateDeliveryStatusDto {
  @IsIn(['OUT_FOR_DELIVERY', 'DELIVERED'])
  status: 'OUT_FOR_DELIVERY' | 'DELIVERED';
}

export class VerifyRazorpayPaymentDto {
  @IsString()
  razorpayOrderId: string;

  @IsString()
  razorpayPaymentId: string;

  @IsString()
  razorpaySignature: string;
}