import * as os from "os";
import * as path from "path";
import { Controller, Get, Param, Req, Res, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import * as fs from "fs";
import * as mime from "mime-types";

/**
 * Serves locally-stored upload files when Cloudflare R2 is not configured.
 * Route: GET /uploads/<key>  (key may contain slashes, e.g. products/id/uuid.jpg)
 *
 * NOTE: Express 5 + path-to-regexp v8 returns wildcard params as string[], not string.
 * We join them here and also fall back to extracting the key from req.path.
 */
@Controller("uploads")
export class UploadsController {
  constructor(private readonly config: ConfigService) {}

  private get uploadDir(): string {
    const configured = this.config.get<string>("uploadDir");
    return configured || path.join(os.tmpdir(), "routeflow-uploads");
  }

  @Get("*path")
  serveFile(
    @Param() params: Record<string, string | string[]>,
    @Req() req: Request,
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
    const urlMatch = (req.path as string).match(/\/uploads\/(.+)$/);
    const urlKey = urlMatch ? urlMatch[1] : "";

    const key = namedKey || urlKey;

    if (!key) {
      throw new NotFoundException("Missing file key");
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
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(resolved).pipe(res);
  }
}
