import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

const PHONE_REGEX = /^\+?[\d\s\-().]{7,20}$/;

export class UpdateDeliveryBoyDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @Matches(PHONE_REGEX, { message: 'Phone number is not valid' })
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
