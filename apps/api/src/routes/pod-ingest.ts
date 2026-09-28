import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { compressImage } from "../storage/compress.util";
import {
  parseImageDataUrl,
  podArtifactKey,
  podCaptureValueRefusal,
  type PodArtifactKind,
} from "./pod-artifacts.util";

/**
 * #2512 (size ratchet, SA-065): the POD-ingest helpers moved verbatim out of routes.service.ts —
 * `this.prisma` / `this.storage` / `this.logger` became `deps.*`; nothing else changed. See the
 * "Durable proof-of-delivery artifacts" section comment in routes.service.ts for the design.
 */
export interface PodIngestDeps {
  prisma: { getTenantId(): string | null | undefined };
  storage: { upload(key: string, body: Buffer, mimeType: string): Promise<unknown> };
  logger: { warn(message: string): void };
}

/** Tenant id for POD storage keys — every POD caller is a tenant-scoped request. */
export function requirePodTenantId(prisma: PodIngestDeps["prisma"]): string {
  const tenantId = prisma.getTenantId();
  if (!tenantId) throw new ForbiddenException("Tenant context required");
  return tenantId;
}

/**
 * Rasterize + store one data-URL artifact; returns the storage key, or null
 * when the value isn't an ingestable image data URL OR the rasterize fails —
 * on failure the caller keeps the original data URL, which is still durable
 * and renderable by the web client (just larger than a stored file).
 */
export async function ingestPodDataUrl(
  deps: PodIngestDeps,
  value: string,
  stopId: string,
  kind: PodArtifactKind,
  artifactId?: string,
): Promise<string | null> {
  const parsed = parseImageDataUrl(value);
  if (!parsed) return null;
  try {
    const compressed = await compressImage(
      parsed.buffer,
      parsed.mimeType,
      kind === "signature" ? 1000 : 1600,
    );
    const key = podArtifactKey(
      requirePodTenantId(deps.prisma),
      stopId,
      kind,
      artifactId ?? randomUUID(),
      compressed.ext,
    );
    await deps.storage.upload(key, compressed.buffer, compressed.mimeType);
    return key;
  } catch (e) {
    deps.logger.warn(`POD ${kind} ingest failed for stop ${stopId}: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/** Rewrite a completion payload's data-URL artifacts to storage keys in place. */
export async function ingestPodCapture(
  deps: PodIngestDeps,
  dto: { signatureUrl?: string; podPhotoUrls?: string[] },
  stopId: string,
): Promise<void> {
  // #2542/#2550: every schemeless value is a storage key and must be exactly this tenant's pod key
  // for THIS stop — refused (400) before anything is uploaded or written.
  // #2585 / SA-519: the 400 names the field (a blank entry is refused, never skipped).
  const values: Array<[string, unknown]> = [
    ...(dto.signatureUrl !== undefined
      ? [["signatureUrl", dto.signatureUrl] as [string, unknown]]
      : []),
    ...(dto.podPhotoUrls ?? []).map((v, i) => [`podPhotoUrls[${i}]`, v] as [string, unknown]),
  ];
  if (values.length > 0) {
    const tenantId = requirePodTenantId(deps.prisma);
    for (const [field, v] of values) {
      const why = podCaptureValueRefusal(v, tenantId, stopId); // #2550: this stop's own keys only
      if (why) throw new BadRequestException(`${field}: ${why}`);
    }
  }
  if (dto.signatureUrl) {
    const key = await ingestPodDataUrl(deps, dto.signatureUrl, stopId, "signature");
    if (key) dto.signatureUrl = key;
  }
  if (dto.podPhotoUrls?.length) {
    const rewritten: string[] = [];
    for (const value of dto.podPhotoUrls) {
      const key = await ingestPodDataUrl(deps, value, stopId, "photo");
      rewritten.push(key ?? value);
    }
    dto.podPhotoUrls = rewritten;
  }
}
