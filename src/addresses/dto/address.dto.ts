import { IsBoolean, IsOptional, IsString, Matches, MinLength } from 'class-validator';

const PHONE_REGEX = /^\+?[\d\s\-().]{7,20}$/;
const POSTAL_CODE_REGEX = /^\d{3,10}$/;

export class CreateAddressDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsString()
  @MinLength(1)
  firstName: string;

  @IsString()
  @MinLength(1)
  lastName: string;

  @IsString()
  @MinLength(1)
  street: string;

  @IsString()
  @MinLength(1)
  city: string;

  @IsString()
  @MinLength(1)
  state: string;

  @Matches(POSTAL_CODE_REGEX, { message: 'Postal code must contain digits only' })
  postalCode: string;

  @IsString()
  @MinLength(1)
  country: string;

  @IsOptional()
  @Matches(PHONE_REGEX, { message: 'Phone number is not valid' })
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  street?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @Matches(POSTAL_CODE_REGEX, { message: 'Postal code must contain digits only' })
  postalCode?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @Matches(PHONE_REGEX, { message: 'Phone number is not valid' })
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
