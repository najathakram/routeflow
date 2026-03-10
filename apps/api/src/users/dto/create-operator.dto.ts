import { IsEmail, IsString } from 'class-validator';

export class CreateOperatorDto {
  @IsEmail() email: string;
  @IsString() username: string;
}
