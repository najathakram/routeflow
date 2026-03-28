import * as path from "path";
import { Controller, Get, Param, Res, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import * as fs from "fs";
import * as mime from "mime-types";

/**
 * Serves locally-stored upload files when Cloudflare R2 is not configured.
 * Route: GET /uploads/:key  (key may contain slashes, e.g. products/id/uuid.jpg)
 */
@Controller("uploads")
export class UploadsController {
  constructor(private readonly config: ConfigService) {}

  private get uploadDir(): string {
    return this.config.get<string>("uploadDir") ?? path.join(process.cwd(), "uploads");
  }

  @Get("*path")
  serveFile(@Param("path") key: string, @Res() res: Response) {
    const filePath = path.join(this.uploadDir, key);

    // Security: prevent path traversal
    const resolved = path.resolve(filePath);
    const base = path.resolve(this.uploadDir);
    if (!resolved.startsWith(base)) {
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
