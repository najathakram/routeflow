/** Promoted from AuthController's former private method (unchanged logic) so the Google
 * OAuth flows can populate RefreshToken.userAgent/ipAddress the same way the credential
 * login path already does. */
export function extractDeviceInfo(req: any): { userAgent?: string; ipAddress?: string } {
  const ua = (req.headers?.["user-agent"] as string) ?? undefined;
  const ip =
    (req.headers?.["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket?.remoteAddress ??
    undefined;
  return { userAgent: ua, ipAddress: ip };
}
