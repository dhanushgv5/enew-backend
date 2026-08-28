import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReturnRequestDto {
  @IsUUID()
  orderItemId: string;

  @IsIn(['RETURN', 'REPLACEMENT'])
  type: 'RETURN' | 'REPLACEMENT';

  @IsInt()
  @Min(1)
  quantity: number;

  @IsString()
  @MaxLength(120)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  // URLs of already-uploaded photos (see POST /returns/photos)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  photos?: string[];
}

const RETURN_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'RECEIVED',
  'REFUNDED',
  'REPLACED',
  'CANCELLED',
] as const;

export class UpdateReturnStatusDto {
  @IsIn(RETURN_STATUSES)
  status: (typeof RETURN_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  // Admin can override the auto-calculated refund amount when moving to REFUNDED
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  refundAmount?: number;
}

// Admin schedules a pickup: picks a date and hands the request off to a
// delivery boy, who then takes it from there (mirrors AssignDeliveryDto).
export class SchedulePickupDto {
  @IsDateString()
  pickupDate: string;

  @IsUUID()
  deliveryBoyId: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

// Delivery boy advances a request they've been assigned to pick up
// (mirrors UpdateDeliveryStatusDto for orders).
export class UpdateReturnDeliveryStatusDto {
  @IsIn(['PICKED_UP', 'RECEIVED'])
  status: 'PICKED_UP' | 'RECEIVED';
}

export class QueryReturnsDto {
  @IsOptional()
  @IsIn(RETURN_STATUSES)
  status?: (typeof RETURN_STATUSES)[number];

  @IsOptional()
  @IsIn(['RETURN', 'REPLACEMENT'])
  type?: 'RETURN' | 'REPLACEMENT';

  @IsOptional()
  @IsUUID()
  orderId?: string;
}
