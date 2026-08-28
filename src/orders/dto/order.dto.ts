import { IsIn, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

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