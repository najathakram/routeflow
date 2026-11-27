import { ArrayMaxSize, IsArray, IsString } from "class-validator";
import { MAIL_WALL_MAX_ENTRIES } from "../../email/recipient-wall";

/**
 * `PUT /platform-admin/tenants/:id/mail-wall` body (W-1464): the whole allowed list of a Test business, replaced in
 * one call. Each entry is `name@domain` or `name+*@domain`; an empty list removes the row. Entries are checked in
 * the service (a bad one names its position, never echoes the address).
 */
export class SetMailWallDto {
  @IsArray()
  @ArrayMaxSize(MAIL_WALL_MAX_ENTRIES)
  @IsString({ each: true })
  addresses!: string[];
}
