import * as os from "os";
import * as path from "path";
import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import * as fs from "fs";
import * as mime from "mime-types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * Serves locally-stored upload files when Cloudflare R2 is not configured.
 * Route: GET /uploads/<key>  (key may contain slashes, e.g. products/id/uuid.jpg)
 *
 * RF-075: Endpoint was previously unauthenticated — any anonymous client could
 * fetch any file (product images, tenant logos, customer tax certificates,
 * driver POD photos, signatures). Now requires a valid JWT and enforces that
 * the file's `tenants/{tenantId}/...` prefix matches the caller's tenantId.
 *
 * NOTE: Express 5 + path-to-regexp v8 returns wildcard params as string[], not string.
 * We join them here and also fall back to extracting the key from req.path.
 */
@Controller("uploads")
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private readonly config: ConfigService) {}

  private get uploadDir(): string {
    const configured = this.config.get<string>("uploadDir");
    return configured || path.join(os.tmpdir(), "routeflow-uploads");
  }

  @Get("*path")
  serveFile(
    @Param() params: Record<string, string | string[]>,
    @Req() req: Request & { user?: JwtPayload },
    @Res() res: Response,
  ) {
    const dir = this.uploadDir;

    // Express 5 + path-to-regexp v8 captures wildcard params as string[].
    // Express 4 returns a plain string. Handle both.
    const rawNamed = params["path"];
    const namedKey = Array.isArray(rawNamed) ? rawNamed.join("/") : (rawNamed ?? "");

    // Fallback: derive from the raw URL path — works regardless of Express version.
    // req.path in NestJS includes the global prefix (e.g. /api/v1/uploads/products/foo.png).
    // Extract everything after the last /uploads/ segment.
    const urlMatch = req.path.match(/\/uploads\/(.+)$/);
    const urlKey = urlMatch ? urlMatch[1] : "";

    const key = namedKey || urlKey;

    if (!key) {
      throw new NotFoundException("Missing file key");
    }

    // Tenant scoping: keys live under `tenants/<tenantId>/...`. Reject if the
    // caller's tenantId doesn't match the prefix. SUPER_ADMIN bypasses.
    const caller = req.user;
    const tenantMatch = key.match(/^tenants\/([^/]+)\//);
    if (tenantMatch && caller?.role !== "SUPER_ADMIN") {
      if (!caller?.tenantId || tenantMatch[1] !== caller.tenantId) {
        throw new ForbiddenException("Cross-tenant file access denied");
      }
    }

    const filePath = path.join(dir, key);

    // Security: prevent path traversal
    const resolved = path.resolve(filePath);
    const base = path.resolve(dir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new NotFoundException();
    }

    if (!fs.existsSync(resolved)) {
      throw new NotFoundException("File not found");
    }

    const contentType = mime.lookup(resolved) || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    // RF-078: Always force download — prevents browser from rendering any file inline
    // (covers SVG XSS, HTML injection, and any future MIME confusion attacks).
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(resolved)}"`);
    // RF-076: Prevent MIME sniffing — browser must honour the declared Content-Type.
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Cache only public assets (images); private documents must not be cached publicly.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    fs.createReadStream(resolved).pipe(res);
  }
}
