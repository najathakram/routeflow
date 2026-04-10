import axios from "axios";

const BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1").replace(/\/$/, "");

export interface BuyerUser {
  id: string;
  email: string;
  name: string;
}

export interface BuyerSeller {
  linkId: string;
  linkStatus: string;
  tenant: { id: string; slug: string; name: string; logoKey: string | null; primaryColor: string | null };
  customer: { id: string; businessName: string; email: string | null };
}

interface BuyerAuthResponse {
  accessToken: string;
  refreshToken: string;
  buyer: BuyerUser;
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }
}

export function getStoredBuyer(): BuyerUser | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem("buyerAccessToken");
  if (!token) return null;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  if ((payload.type as string) !== "BUYER") return null;
  return { id: payload.sub as string, email: payload.email as string, name: payload.name as string };
}

export function getStoredActiveSeller(): BuyerSeller | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("buyerActiveSeller");
  if (!raw) return null;
  try { return JSON.parse(raw) as BuyerSeller; } catch { return null; }
}

export function storeActiveSeller(seller: BuyerSeller): void {
  localStorage.setItem("buyerActiveSeller", JSON.stringify(seller));
}

export function clearActiveSeller(): void {
  localStorage.removeItem("buyerActiveSeller");
}

export async function buyerLogin(email: string, password: string): Promise<BuyerAuthResponse> {
  const { data } = await axios.post<BuyerAuthResponse>(`${BASE_URL}/buyer/auth/login`, { email, password });
  localStorage.setItem("buyerAccessToken", data.accessToken);
  localStorage.setItem("buyerRefreshToken", data.refreshToken);
  return data;
}

export async function buyerRegister(email: string, password: string, name: string): Promise<BuyerAuthResponse> {
  const { data } = await axios.post<BuyerAuthResponse>(`${BASE_URL}/buyer/auth/register`, { email, password, name });
  localStorage.setItem("buyerAccessToken", data.accessToken);
  localStorage.setItem("buyerRefreshToken", data.refreshToken);
  return data;
}

export async function buyerLogout(): Promise<void> {
  try {
    const token = localStorage.getItem("buyerAccessToken");
    if (token) {
      await axios.post(`${BASE_URL}/buyer/auth/logout`, {}, { headers: { Authorization: `Bearer ${token}` } });
    }
  } catch { /* best-effort */ }
  localStorage.removeItem("buyerAccessToken");
  localStorage.removeItem("buyerRefreshToken");
  localStorage.removeItem("buyerActiveSeller");
}

export async function buyerRefreshTokens(): Promise<BuyerAuthResponse | null> {
  const refreshToken = typeof window !== "undefined" ? localStorage.getItem("buyerRefreshToken") : null;
  if (!refreshToken) return null;
  try {
    const { data } = await axios.post<BuyerAuthResponse>(`${BASE_URL}/buyer/auth/refresh`, { refreshToken });
    localStorage.setItem("buyerAccessToken", data.accessToken);
    localStorage.setItem("buyerRefreshToken", data.refreshToken);
    return data;
  } catch { return null; }
}

export async function getInviteDetails(token: string): Promise<{ name: string; slug: string; logoKey: string | null }> {
  const { data } = await axios.get(`${BASE_URL}/buyer/invites/${token}/details`);
  // API returns sellerName/sellerSlug; map to the shape the invite page expects
  return {
    name: data.sellerName ?? data.name ?? "",
    slug: data.sellerSlug ?? data.slug ?? "",
    logoKey: data.logoKey ?? null,
  };
}

export async function acceptInvite(token: string, accessToken: string): Promise<void> {
  await axios.post(`${BASE_URL}/buyer/invites/${token}/accept`, {}, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function getBuyerSellers(accessToken: string): Promise<BuyerSeller[]> {
  const { data } = await axios.get<BuyerSeller[]>(`${BASE_URL}/buyer/sellers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}
