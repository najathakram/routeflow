import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { POD_ARTIFACT_KINDS, POD_ARTIFACT_ID_RE } from "../pod-artifacts.util";

/**
 * POST /route-runs/:id/stops/:stopId/pod-artifact
 *
 * One artifact per request, as a JSON data URL — deliberately NOT multipart:
 * FormData requests are excluded from the mobile offline queue, so a driver in
 * a dead zone still gets their POD photos attached when the queue replays
 * (JSON attaches are enqueued before the queued completion, replayed FIFO).
 * The 2MB global JSON body limit caps one artifact per request.
 */
export class AttachPodArtifactDto {
  @IsIn(POD_ARTIFACT_KINDS) kind: (typeof POD_ARTIFACT_KINDS)[number];

  @IsString() @MaxLength(1_900_000) dataUrl: string;

  /**
   * Client-generated stable id so an offline-queue replay whose response was
   * lost re-attaches idempotently instead of duplicating the photo.
   */
  @IsOptional() @IsString() @Matches(POD_ARTIFACT_ID_RE) artifactId?: string;
}
