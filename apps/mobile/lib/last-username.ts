import { Platform } from "react-native";
import { toSecureStoreKey } from "./secure-key";

/**
 * Remembers the last successfully signed-in staff username so the login screen
 * can prefill it after a session expires — one less field to retype on the
 * re-login path. A convenience prefill, not a secret; it deliberately survives
 * logout and token wipes.
 */

export const LAST_USERNAME_KEY = "rf:lastUsername";

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") return localStorage.getItem(key);
  const { getItemAsync } = await import("expo-secure-store");
  return getItemAsync(toSecureStoreKey(key));
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.setItem(key, value);
    return;
  }
  const { setItemAsync } = await import("expo-secure-store");
  await setItemAsync(toSecureStoreKey(key), value);
}

export async function getLastUsername(): Promise<string | null> {
  try {
    return await storageGet(LAST_USERNAME_KEY);
  } catch {
    return null;
  }
}

export async function setLastUsername(username: string): Promise<void> {
  if (!username) return;
  try {
    await storageSet(LAST_USERNAME_KEY, username);
  } catch {
    // Best-effort — a failed prefill save must never break login.
  }
}
