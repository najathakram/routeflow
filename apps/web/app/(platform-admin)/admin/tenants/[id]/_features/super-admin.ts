/** Best-effort client-side check — the real gate is the server + the route's SuperAdminGuard. */
export function currentRoleIsSuperAdmin(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const token = window.localStorage.getItem("superAdminToken");
    if (!token) return false;
    const part = token.split(".")[1];
    if (!part) return false;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "SUPER_ADMIN";
  } catch {
    return false;
  }
}
