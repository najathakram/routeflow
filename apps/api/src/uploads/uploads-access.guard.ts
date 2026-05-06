import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";
import { verifyLocalUrlSignature } from "../storage/storage.service";

/**
 * Two-mode auth guard for GET /uploads/<key>:
 *
 *   1. HMAC-signed query string (`?expires=&sig=`) issued by
 *      StorageService.presignedUrl — the signature is bound to one specific
 *      key and a bounded expiry, so the signature *is* the authorization.
 *      This is the path browser `<img>` tags use cross-origin (they cannot
 *      send Authorization headers).
 *
 *   2. Otherwise, fall through to the standard JWT bearer check
 *      (Passport jwt strategy). Tenant prefix scoping then applies in the
 *      controller as it always has.
 *
 * Sets `req.signedUrlAuthorized = true` on the request when path 1 succeeds,
 * so the controller knows to skip the JWT-tenant check.
 */
@Injectable()
export class UploadsAccessGuard extends AuthGuard("jwt") implements CanActivate {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<
      Request & { signedUrlAuthorized?: boolean }
    >();

    // Derive the storage key from the URL the same way the controller does.
    const urlMatch = req.path.match(/\/uploads\/(.+)$/);
    const key = urlMatch ? decodeURIComponent(urlMatch[1]) : "";

    const expiresRaw = (req.query.expires as string | undefined) ?? "";
    const sig = (req.query.sig as string | undefined) ?? "";

    if (key && expiresRaw && sig) {
      const expiresAt = parseInt(expiresRaw, 10);
      const secret = this.config.get<string>("storage.urlSigningSecret") ?? "";
      if (verifyLocalUrlSignature(secret, key, expiresAt, sig)) {
        req.signedUrlAuthorized = true;
        return true;
      }
      // Bad/expired signature: fall through to JWT path so a logged-in
      // operator can still load the file directly. We do NOT short-circuit
      // to 401 here.
    }

    // Standard JWT bearer auth.
    return (await super.canActivate(context)) as boolean;
  }
}
