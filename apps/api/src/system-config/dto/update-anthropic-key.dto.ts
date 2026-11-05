import { ClaudeApiKey } from "../../common/claude-api-key";

/** `PATCH /settings/anthropic` body (SA-1102 A-1(d)): the business's own Claude key, or "" to remove it. */
export class UpdateAnthropicKeyDto {
  @ClaudeApiKey()
  apiKey?: string;
}
