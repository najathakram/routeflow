import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { ClaudeApiKey } from "../../common/claude-api-key";

/**
 * `PATCH /platform-admin/ai-config` body. The model ids are checked against the AI_MODELS list by the service (a coded
 * 400), so they are plain strings here. `apiKey` is "" (clear) or a well-formed Claude key (SA-1102 A-1(d)).
 * `monthlyCapUsd` is the per-business monthly allowance on RouteFlow's key; 0 turns AI off on it (SA-1102 B1).
 */
export class UpdateAiConfigDto {
  @ClaudeApiKey()
  apiKey?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  scanModel?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200000)
  maxTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  monthlyCapUsd?: number;
}
