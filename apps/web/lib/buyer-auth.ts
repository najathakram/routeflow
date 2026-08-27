import axios from "axios";
import { BUYER_KEYS } from "./auth-keys";
import { setBuyerPresenceCookie, clearBuyerPresenceCookie } from "./presence-cookies";

const BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1").replace(
  /\/$/,
  "",
);

export interface BuyerUser {
  id: string;
  email: string;
  name: string;
}

export interface BuyerSeller {
  linkId: string;
  linkStatus: string;
  tenant: {
    id: string;
    slug: string;
    name: string;
    logoKey: string | null;
    primaryColor: string | null;
  };
  customer: { id: string; businessName: string; email: string | null } | null;
}

interface BuyerAuthResponse {
  accessToken: string;
  refreshToken: string;
  buyer: BuyerUser;
}

// Legacy pre-NEW-m2-1/RF-077 key — still written by the Google OAuth callback
// (for unmigrated readers) and read as a fallback by getBuyerAccessToken().
const LEGACY_BUYER_ACCESS = "buyerAccessToken";

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/**
 * Canonical accessor for the buyer access token — the namespaced key first,
 * falling back to the legacy pre-NEW-m2-1 key so sessions written by older
 * code paths keep working. ALL buyer token reads must go through this: the
 * A5 seller-list outage came from call sites still reading the legacy
 * literal ("buyerAccessToken"), which plain email/password login never
 * writes — only the Google OAuth callback backfilled it, so password logins
 * on a fresh device saw no sellers and could never reach a dashboard.
 */
export function getBuyerAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(BUYER_KEYS.accessToken) ?? localStorage.getItem(LEGACY_BUYER_ACCESS);
}

export function getStoredBuyer(): BuyerUser | null {
  const token = getBuyerAccessToken();
  if (!token) return null;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  if ((payload.type as string) !== "BUYER") return null;
  return {
    id: payload.sub as string,
    email: payload.email as string,
    name: payload.name as string,
  };
}

export function getStoredActiveSeller(): BuyerSeller | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(BUYER_KEYS.activeSeller);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BuyerSeller;
  } catch {
    return null;
  }
}

export function storeActiveSeller(seller: BuyerSeller): void {
  localStorage.setItem(BUYER_KEYS.activeSeller, JSON.stringify(seller));
}

export function clearActiveSeller(): void {
  localStorage.removeItem(BUYER_KEYS.activeSeller);
}

export { BUYER_PRESENCE_COOKIE, clearBuyerPresenceCookie } from "./presence-cookies";

export async function buyerLogin(email: string, password: string): Promise<BuyerAuthResponse> {
  const { data } = await axios.post<BuyerAuthResponse>(`${BASE_URL}/buyer/auth/login`, {
    email,
    password,
  });
  localStorage.setItem(BUYER_KEYS.accessToken, data.accessToken);
  localStorage.setItem(BUYER_KEYS.refreshToken, data.refreshToken);
  setBuyerPresenceCookie();
  return data;
}

export async function buyerRegister(
  email: string,
  password: string,
  name: string,
): Promise<BuyerAuthResponse> {
  const { data } = await axios.post<BuyerAuthResponse>(`${BASE_URL}/buyer/auth/register`, {
    email,
    password,
    name,
  });
  localStorage.setItem(BUYER_KEYS.accessToken, data.accessToken);
  localStorage.setItem(BUYER_KEYS.refreshToken, data.refreshToken);
  setBuyerPresenceCookie();
  return data;
}

export async function buyerLogout(): Promise<void> {
  try {
    const token = localStorage.getItem(BUYER_KEYS.accessToken);
    if (token) {
      await axios.post(
        `${BASE_URL}/buyer/auth/logout`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
    }
  } catch {
    /* best-effort */
  }
  localStorage.removeItem(BUYER_KEYS.accessToken);
  localStorage.removeItem(BUYER_KEYS.refreshToken);
  localStorage.removeItem(BUYER_KEYS.activeSeller);
  Object.keys(localStorage)
    .filter((k) => k.startsWith("buyerCart_"))
    .forEach((k) => localStorage.removeItem(k));
  clearBuyerPresenceCookie();
}

export async function buyerRefreshTokens(): Promise<BuyerAuthResponse | null> {
  const refreshToken =
    typeof window !== "undefined" ? localStorage.getItem(BUYER_KEYS.refreshToken) : null;
  if (!refreshToken) return null;
  try {
    const { data } = await axios.post<BuyerAuthResponse>(`${BASE_URL}/buyer/auth/refresh`, {
      refreshToken,
    });
    localStorage.setItem(BUYER_KEYS.accessToken, data.accessToken);
    localStorage.setItem(BUYER_KEYS.refreshToken, data.refreshToken);
    // Sliding window — see presence-cookies.ts.
    setBuyerPresenceCookie();
    return data;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) clearBuyerPresenceCookie();
    return null;
  }
}

export async function buyerChangePassword(
  currentPassword: string,
  newPassword: string,
  accessToken: string,
): Promise<void> {
  await axios.post(
    `${BASE_URL}/buyer/auth/change-password`,
    { currentPassword, newPassword },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

/**
 * First-password setup for Google-auto-created buyer accounts. Only accepted
 * while the account's passwordSet flag is false (server-verified). Stores the
 * reissued token pair so the caller stays signed in.
 */
export async function buyerSetPassword(newPassword: string, accessToken: string): Promise<void> {
  const { data } = await axios.post<{ accessToken?: string; refreshToken?: string }>(
    `${BASE_URL}/buyer/auth/set-password`,
    { newPassword },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (data.accessToken && data.refreshToken) {
    localStorage.setItem(BUYER_KEYS.accessToken, data.accessToken);
    localStorage.setItem(BUYER_KEYS.refreshToken, data.refreshToken);
    setBuyerPresenceCookie();
  }
}

export interface BuyerProfile {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  mobile: string | null;
  emailVerified: boolean;
  createdAt: string;
  googleLinked: boolean;
  /** Authoritative — false means Google-created with no usable password yet. */
  hasPassword: boolean;
}

export async function getBuyerProfile(accessToken: string): Promise<BuyerProfile> {
  const { data } = await axios.get<BuyerProfile>(`${BASE_URL}/buyer/auth/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

export async function buyerRequestPasswordReset(email: string): Promise<void> {
  await axios.post(`${BASE_URL}/buyer/auth/request-password-reset`, { email });
}

export async function buyerResetPassword(token: string, newPassword: string): Promise<void> {
  await axios.post(`${BASE_URL}/buyer/auth/reset-password`, { token, newPassword });
}

export async function buyerVerifyEmail(token: string): Promise<{ message: string }> {
  const { data } = await axios.post<{ message: string }>(`${BASE_URL}/buyer/auth/verify-email`, {
    token,
  });
  return data;
}

export async function buyerResendVerification(
  accessToken: string,
): Promise<{ message: string; sent: boolean; alreadyVerified?: boolean }> {
  const { data } = await axios.post<{ message: string; sent: boolean; alreadyVerified?: boolean }>(
    `${BASE_URL}/buyer/auth/resend-verification`,
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return data;
}

export async function requestSellerConnection(
  sellerSlug: string,
  emailAtSeller: string,
  accessToken: string,
): Promise<{ message: string; linkId?: string }> {
  const { data } = await axios.post(
    `${BASE_URL}/buyer/sellers/request`,
    { sellerSlug, emailAtSeller },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return data as { message: string; linkId?: string };
}

export async function getInviteDetails(
  token: string,
): Promise<{ name: string; slug: string; logoKey: string | null }> {
  const { data } = await axios.get(`${BASE_URL}/buyer/invites/${token}/details`);
  return {
    name:
      (data as { sellerName?: string; name?: string }).sellerName ??
      (data as { name?: string }).name ??
      "",
    slug:
      (data as { sellerSlug?: string; slug?: string }).sellerSlug ??
      (data as { slug?: string }).slug ??
      "",
    logoKey: (data as { logoKey?: string | null }).logoKey ?? null,
  };
}

export async function acceptInvite(token: string, accessToken: string): Promise<void> {
  await axios.post(
    `${BASE_URL}/buyer/invites/${token}/accept`,
    {},
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
}

export async function getBuyerSellers(accessToken: string): Promise<BuyerSeller[]> {
  const { data } = await axios.get<BuyerSeller[]>(`${BASE_URL}/buyer/sellers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}
