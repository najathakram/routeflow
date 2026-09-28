/**
 * #2653 — the hybrid shell's config for THIS build, read once. Direct `process.env.EXPO_PUBLIC_*`
 * member reads so Expo inlines them at build time (eas.json sets both on every profile, pinned by
 * __tests__/web-shell-eas-env.test.ts). null ⇒ the shell is OFF and the native screens run.
 */
import { readShellConfig, type ShellConfig } from "./shell-config";

export const SHELL_CONFIG: ShellConfig | null = readShellConfig({
  EXPO_PUBLIC_WEB_URL: process.env.EXPO_PUBLIC_WEB_URL,
  EXPO_PUBLIC_WEB_SHELL: process.env.EXPO_PUBLIC_WEB_SHELL,
});

export const SHELL_ON = SHELL_CONFIG !== null;
