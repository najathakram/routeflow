import axios from "axios";
import { BUYER_KEYS } from "./auth-keys";

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
  customer: { id: string; businessName: string; email: string | null };
}

interface BuyerAuthResponse {
  accessToken: string;
  refreshToken: string;
  buyer: BuyerUser;
}

// Legacy keys used before NEW-m2-1 / RF-077
const LEGACY_BUYER_ACCESS = "buyerAccessToken";
const LEGACY_BUYER_REFRESH = "buyerRefreshToken";
const LEGACY_BUYER_SELLER = "buyerActiveSeller";

/**
 * One-time migration: copy legacy buyerAccessToken → rf:buyer:accessToken then
 * delete the legacy keys. Idempotent — safe to call on every page load.
 */
export function migrateLegacyBuyerToken(): void {
  if (typeof window === "undefined") return;
  const legacy = localStorage.getItem(LEGACY_BUYER_ACCESS);
  if (!legacy) return;
  if (!localStorage.getItem(BUYER_KEYS.accessToken)) {
    localStorage.setItem(BUYER_KEYS.accessToken, legacy);
    const legacyRefresh = localStorage.getItem(LEGACY_BUYER_REFRESH);
    if (legacyRefresh) localStorage.setItem(BUYER_KEYS.refreshToken, legacyRefresh);
    const legacySeller = localStorage.getItem(LEGACY_BUYER_SELLER);
    if (legacySeller) localStorage.setItem(BUYER_KEYS.activeSeller, legacySeller);
  }
  localStorage.removeItem(LEGACY_BUYER_ACCESS);
  localStorage.removeItem(LEGACY_BUYER_REFRESH);
  localStorage.removeItem(LEGACY_BUYER_SELLER);
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export function getStoredBuyer(): BuyerUser | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(BUYER_KEYS.accessToken);
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

export const BUYER_PRESENCE_COOKIE = "rf-buyer-auth";

function setBuyerPresenceCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${BUYER_PRESENCE_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
}

function clearBuyerPresenceCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${BUYER_PRESENCE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

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
    return data;
  } catch {
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
