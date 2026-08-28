import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';

// Digits, spaces, and + - ( ) only, 7-20 chars - blocks arbitrary text
// while still allowing common phone number formats.
const PHONE_REGEX = /^\+?[\d\s\-().]{7,20}$/;

export class CreateDeliveryBoyDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @Matches(PHONE_REGEX, { message: 'Phone number is not valid' })
  phone?: string;
}
