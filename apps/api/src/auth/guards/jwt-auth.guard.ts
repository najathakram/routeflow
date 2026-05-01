import { ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  /** RF-093: block all requests when forcePasswordChange=true, except the change-password endpoint. */
  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    if (err || !user) throw err ?? new UnauthorizedException();

    if (user.forcePasswordChange) {
      const req = context.switchToHttp().getRequest<{ method: string; path: string }>();
      const isChangePassword =
        req.method === "POST" && req.path.endsWith("/auth/change-password");
      if (!isChangePassword) {
        throw new ForbiddenException(
          "Password change required. Please update your password before continuing.",
        );
      }
    }

    return user;
  }
}
