import { IsEmail, IsOptional, IsString } from 'class-validator';

export class CreateDriverDto {
  @IsString() contactName: string;
  @IsEmail() email: string;
  @IsString() username: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() vehicleMake?: string;
  @IsOptional() @IsString() vehicleModel?: string;
  @IsOptional() @IsString() vehicleColour?: string;
  @IsOptional() @IsString() vehiclePlate?: string;
}
