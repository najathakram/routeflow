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
 */
@Controller("uploads")
export class UploadsController {
  constructor(private readonly config: ConfigService) {}

  private get uploadDir(): string {
    const configured = this.config.get<string>("uploadDir");
    return configured || path.join(os.tmpdir(), "routeflow-uploads");
  }

  /** Debug endpoint — lists files in uploadDir so you can verify storage is working. */
  @Get("_debug/ls")
  debugLs(@Res() res: Response) {
    const dir = this.uploadDir;
    const walk = (d: string, base: string): string[] => {
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).flatMap((f) => {
        const full = path.join(d, f);
        const rel = path.join(base, f);
        return fs.statSync(full).isDirectory() ? walk(full, rel) : [rel];
      });
    };
    const files = walk(dir, "");
    res.json({ uploadDir: dir, fileCount: files.length, files: files.slice(0, 100) });
  }

  @Get("*path")
  serveFile(@Param() params: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    const dir = this.uploadDir;

    // Extract the key using multiple strategies for Express 4/5 + path-to-regexp v6/v8 compatibility.
    // Strategy 1: named wildcard param (Express 5 / path-to-regexp v8 "named" wildcard)
    const namedKey = params["path"];
    // Strategy 2: unnamed wildcard (Express 4 captures to params["0"])
    const unnamedKey = params["0"];
    // Strategy 3: derive from the raw URL path — most reliable regardless of Express version
    // req.path inside a NestJS controller is the path AFTER the global prefix is stripped,
    // e.g.  /uploads/products/abc/uuid.png  → strip "/uploads/" → products/abc/uuid.png
    const uploadsPrefix = "/uploads/";
    const urlKey = req.path.startsWith(uploadsPrefix)
      ? req.path.slice(uploadsPrefix.length)
      : req.path.replace(/^\//, "");

    const key = namedKey || unnamedKey || urlKey;

    // Log for diagnostics — visible in Railway Deploy Logs
    console.log("[UploadsController] serveFile", {
      uploadDir: dir,
      namedKey,
      unnamedKey,
      urlKey,
      chosenKey: key,
      reqPath: req.path,
    });

    if (!key) {
      throw new NotFoundException("Missing file key");
    }

    const filePath = path.join(dir, key);

    // Security: prevent path traversal
    const resolved = path.resolve(filePath);
    const base = path.resolve(dir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      console.warn("[UploadsController] Path traversal attempt", { resolved, base });
      throw new NotFoundException();
    }

    console.log("[UploadsController] checking file", { resolved, exists: fs.existsSync(resolved) });

    if (!fs.existsSync(resolved)) {
      throw new NotFoundException("File not found");
    }

    const contentType = mime.lookup(resolved) || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(resolved).pipe(res);
  }
}
