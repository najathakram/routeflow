import * as os from "os";
import * as path from "path";
import {
  Controller,
  ForbiddenException,
  Get,
  Logger,
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
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { UploadsAccessGuard } from "./uploads-access.guard";

/**
 * Serves locally-stored upload files when Cloudflare R2 is not configured.
 * Route: GET /uploads/<key>  (key may contain slashes, e.g. products/id/uuid.jpg)
 *
 * Auth (UploadsAccessGuard): accepts EITHER an HMAC-signed query string
 * (?expires=&sig=) issued by StorageService.presignedUrl, OR a valid JWT
 * bearer token. The signed-URL path is what allows browser `<img>` tags
 * to load cross-origin (they can't send Authorization headers). The JWT
 * path keeps server-to-server callers and any direct API consumers
 * working unchanged.
 *
 * RF-075: Endpoint was previously unauthenticated — any anonymous client could
 * fetch any file (product images, tenant logos, customer tax certificates,
 * driver POD photos, signatures). With a signed URL, the signature scopes
 * access to one specific key for a bounded duration; with a JWT, the file's
 * `tenants/{tenantId}/...` prefix is enforced against the caller's tenantId.
 *
 * NOTE: Express 5 + path-to-regexp v8 returns wildcard params as string[], not string.
 * We join them here and also fall back to extracting the key from req.path.
 */
@Controller("uploads")
@UseGuards(UploadsAccessGuard)
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get uploadDir(): string {
    const configured = this.config.get<string>("uploadDir");
    return configured || path.join(os.tmpdir(), "routeflow-uploads");
  }

  // Eight of the eleven storage prefixes (products, customers, expenses,
  // invoice-scans, invoice-pdfs, statement-pdfs, payments, supplier-statements)
  // embed only the OWNING ROW's id, not a tenantId, so the regex below cannot
  // gate them — resolve the owner's tenant and compare. Without this, any
  // authenticated caller in any tenant who knows a key streams the file (a
  // former employee, a low-priv account, or any IDOR that leaks an id).
  // SUPER_ADMIN stays exempt, as does a signed URL, which is itself a per-key
  // capability. Uses the unscoped PrismaService (this endpoint sits outside
  // the tenant-scoped request path) with select-only queries.
  private readonly OWNER_LOOKUPS: Record<
    string,
    (id: string) => Promise<{ tenantId: string | null } | null>
  > = {
    products: (id) => this.prisma.product.findUnique({ where: { id }, select: { tenantId: true } }),
    customers: (id) =>
      this.prisma.customer.findUnique({ where: { id }, select: { tenantId: true } }),
    // Null-tenantId Expense rows are real in prod (nested-create trap), so a
    // bare comparison would 403 the file for its LEGITIMATE owner. Resolve
    // through the parent vendor bill first. Expense has no Prisma relation to
    // VendorBill (`vendorBillId` is a bare scalar), hence the second lookup
    // rather than a nested select. Still fails closed when neither resolves.
    expenses: async (id) => {
      const row = await this.prisma.expense.findUnique({
        where: { id },
        select: { tenantId: true, vendorBillId: true },
      });
      if (!row) return null;
      if (row.tenantId || !row.vendorBillId) return { tenantId: row.tenantId ?? null };
      const bill = await this.prisma.vendorBill.findUnique({
        where: { id: row.vendorBillId },
        select: { tenantId: true },
      });
      return { tenantId: bill?.tenantId ?? null };
    },
    "invoice-scans": (id) =>
      this.prisma.invoiceScan.findUnique({ where: { id }, select: { tenantId: true } }),
    "invoice-pdfs": (id) =>
      this.prisma.invoice.findUnique({ where: { id }, select: { tenantId: true } }),
    "statement-pdfs": (id) =>
      this.prisma.customer.findUnique({ where: { id }, select: { tenantId: true } }),
    // Same null-tenantId trap as expenses above — resolve through the parent
    // invoice (a payment always has one) before denying.
    payments: async (id) => {
      const row = await this.prisma.invoicePayment.findFirst({
        where: { OR: [{ id }, { paymentGroupId: id }] },
        select: { tenantId: true, invoice: { select: { tenantId: true } } },
      });
      return row ? { tenantId: row.tenantId ?? row.invoice?.tenantId ?? null } : null;
    },
    // B52: `supplier-statements/<scanId>/<n>.<ext>` — the scan row owns the tenant.
    // The id segment carries no extension, so the strip below is a no-op here.
    "supplier-statements": (id) =>
      this.prisma.supplierStatementScan.findUnique({ where: { id }, select: { tenantId: true } }),
  };

  /**
   * B52: log every JWT-path denial, then throw the SAME opaque 403 as before —
   * the response must keep disclosing nothing (not even whether the key exists).
   * The log line is therefore the only signal an operator gets when a read that
   * used to work starts 403ing (a legacy directory under a prefix this controller
   * does not map, or an owner row whose `tenantId` was never injected), so it
   * names the branch that fired, the key and the caller. Keys are id/UUID paths
   * (see StorageService), not user-supplied filenames; the value is still
   * JSON-escaped and clipped so a crafted key cannot forge log lines.
   */
  private denyFileAccess(reason: string, key: string, caller?: JwtPayload): never {
    const shown = key.length > 200 ? `${key.slice(0, 200)}...` : key;
    this.logger.warn(
      `Upload access denied (${reason}): key=${JSON.stringify(shown)} ` +
        `user=${caller?.sub ?? "none"} tenant=${caller?.tenantId ?? "none"} ` +
        `role=${caller?.role ?? "none"}`,
    );
    throw new ForbiddenException("Cross-tenant file access denied");
  }

  @Get("*path")
  async serveFile(
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

    // Reject dot-segments BEFORE any auth decision. Both tenant gates below key
    // off the RAW key, but the file is read from `path.join(dir, key)`, which
    // normalizes `..` — so `products/<my-own-id>/../../tenants/<victim>/doc.pdf`
    // passes the owner lookup on the attacker's OWN product, then resolves to a
    // path that is still inside the upload root (so the traversal check below
    // also passes) and streams another tenant's file. An unknown first segment
    // (`x/../products/<id>/img.jpg`) skips both gates the same way. Express does
    // not normalize dot segments and DOES percent-decode wildcard params, so
    // `%2e%2e` arrives here as `..`. Backslash is a path separator on Windows.
    if (key.split(/[/\\]/).some((segment) => segment === "." || segment === "..")) {
      throw new NotFoundException();
    }

    // Tenant scoping for the JWT-auth path. UploadsAccessGuard sets
    // `req.signedUrlAuthorized = true` when the caller authenticated via
    // the HMAC-signed query string — in that case the signature is itself
    // a delegated capability bound to this exact key, so we don't re-check
    // the tenant prefix (it would block legitimate cross-origin <img> loads
    // for buyer/portal pages where there's no operator JWT).
    const reqAny = req as Request & { user?: JwtPayload; signedUrlAuthorized?: boolean };
    if (!reqAny.signedUrlAuthorized) {
      const caller = reqAny.user;
      // Every tenant-scoped storage prefix embeds `<prefix>/<tenantId>/...`.
      // Enforce the embedded tenantId against the JWT caller so a bearer token
      // can't fetch another tenant's regulatory artifacts (filings / tobacco
      // reports) or tenant files by guessing the key. The signed-URL path is
      // exempt above — the signature is itself a per-key capability.
      const tenantMatch = key.match(/^(?:tenants|regulated-filings|tobacco-reports)\/([^/]+)\//);
      if (tenantMatch && caller?.role !== "SUPER_ADMIN") {
        if (!caller?.tenantId || tenantMatch[1] !== caller.tenantId) {
          this.denyFileAccess("tenant-prefix mismatch", key, caller);
        }
      }

      // The remaining prefixes (products/, customers/, payments/, expenses/,
      // invoice-scans/, invoice-pdfs/, statement-pdfs/, supplier-statements/)
      // embed only the OWNING ROW's id, not a tenantId, so the regex above
      // never matches them and they fell through unguarded. Resolve the
      // owner's tenantId instead. Strip a trailing file extension for the
      // flat `invoice-pdfs/<id>.pdf` case; every other prefix's id segment
      // has no extension to strip. Anything else is denied below (B52).
      const [prefix, idSegmentRaw] = key.split("/");
      const idSegment = idSegmentRaw ? idSegmentRaw.replace(/\.[^./]+$/, "") : idSegmentRaw;
      const ownerLookup = this.OWNER_LOOKUPS[prefix];
      if (ownerLookup && caller?.role !== "SUPER_ADMIN") {
        const owner = idSegment ? await ownerLookup(idSegment) : null;
        // Fail closed: a missing owner row (bad id, deleted row) must deny,
        // never fall through to allow.
        if (!owner || !caller?.tenantId || owner.tenantId !== caller.tenantId) {
          // Name the three shapes apart: a missing row (bad/deleted id), a legacy
          // row whose tenantId was never injected, and a genuine cross-tenant read.
          const reason = !owner
            ? `no owner row for ${prefix}`
            : owner.tenantId == null
              ? `owner row has no tenantId for ${prefix}`
              : `owner tenant mismatch on ${prefix}`;
          this.denyFileAccess(reason, key, caller);
        }
      }

      // B52: fail CLOSED. Every prefix StorageService writes (11 at the time of
      // writing) is covered by one of the two gates above; a key under any other
      // prefix — or a flat key with no prefix at all — has no owner to check and
      // must not stream to a bearer caller. This runs BEFORE the filesystem check
      // so 403-vs-404 never discloses whether a key exists. SUPER_ADMIN and the
      // signed-URL path (a per-key capability) stay exempt. The denial is logged
      // (denyFileAccess) — an unmapped prefix is exactly the case an operator has
      // to be able to see, since the 403 body deliberately says nothing.
      if (!tenantMatch && !ownerLookup && caller?.role !== "SUPER_ADMIN") {
        this.denyFileAccess(
          key.includes("/")
            ? `unmapped prefix ${JSON.stringify(String(prefix).slice(0, 64))}`
            : "flat key (no prefix)",
          key,
          caller,
        );
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
    // RF-078: Default to attachment so unknown / non-image content downloads
    // instead of rendering inline (covers SVG XSS, HTML injection, etc).
    // For the allowlisted raster image types we explicitly serve `inline`
    // so cross-origin <img> tags can render them on the buyer/operator UI.
    // Upload-time MIME validation in products.controller.ts already restricts
    // these to JPEG/PNG/WEBP, so inline rendering is safe.
    // application/pdf is ALSO allowlisted here (2026-07-30): customer document
    // uploads are MIME-allowlisted at the customer-document endpoint to
    // jpeg/png/webp/pdf only, the browser's built-in PDF viewer is sandboxed
    // (no script execution against this origin), and nosniff + the signed-URL
    // gate above are unchanged — so rendering a PDF inline carries the same
    // guarantees as the raster types. Do NOT widen this set to any other
    // type (e.g. SVG or HTML) — that exclusion is a deliberate XSS control.
    const RENDERABLE_INLINE_MIMES = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]);
    if (RENDERABLE_INLINE_MIMES.has(contentType)) {
      res.setHeader("Content-Disposition", "inline");
    } else {
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(resolved)}"`);
    }
    // RF-076: Prevent MIME sniffing — browser must honour the declared Content-Type.
    res.setHeader("X-Content-Type-Options", "nosniff");
    // The global Helmet defaults set Cross-Origin-Resource-Policy: same-origin,
    // which silently blocks <img> on www.routeflow.info from loading files
    // served by routeflowapi-production.up.railway.app. The signed URL is
    // itself the auth gate, so allowing cross-origin embedding is safe.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Cache only public assets (images); private documents must not be cached publicly.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    fs.createReadStream(resolved).pipe(res);
  }
}
