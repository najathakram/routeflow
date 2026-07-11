/**
 * Last-username prefill storage — remembers the last signed-in staff username
 * so the login screen can prefill it after a session expiry.
 */

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { getLastUsername, setLastUsername } from "../lib/last-username";

describe("last-username storage", () => {
  it("returns null before anything was stored", async () => {
    expect(await getLastUsername()).toBeNull();
  });

  it("round-trips a stored username", async () => {
    await setLastUsername("jordan.m");
    expect(await getLastUsername()).toBe("jordan.m");
  });

  it("ignores empty usernames (keeps the previous value)", async () => {
    await setLastUsername("jordan.m");
    await setLastUsername("");
    expect(await getLastUsername()).toBe("jordan.m");
  });

  it("overwrites with the most recent sign-in", async () => {
    await setLastUsername("jordan.m");
    await setLastUsername("alex.k");
    expect(await getLastUsername()).toBe("alex.k");
  });
});
