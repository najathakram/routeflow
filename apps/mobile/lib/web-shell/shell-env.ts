/**
 * #2653 — the hybrid shell's config for THIS build, read once. Direct `process.env.EXPO_PUBLIC_*`
 * member reads so Expo inlines them at build time (eas.json sets both on every profile, pinned by
 * __tests__/web-shell-eas-env.test.ts). null ⇒ the shell is OFF and the native screens run.
 */
import { readShellConfig, shellMode, type ShellConfig, type ShellMode } from "./shell-config";

export const SHELL_CONFIG: ShellConfig | null = readShellConfig({
  EXPO_PUBLIC_WEB_URL: process.env.EXPO_PUBLIC_WEB_URL,
  EXPO_PUBLIC_WEB_SHELL: process.env.EXPO_PUBLIC_WEB_SHELL,
});

/**
 * W-830: "unavailable" = a store build with no usable web URL. The root layout shows an "update
 * required" screen for the old native web-role screens instead of falling back to them.
 * `EXPO_OS` is inlined by Expo at build time (no react-native import: this module stays pure).
 */
export const SHELL_MODE: ShellMode = shellMode(
  {
    EXPO_PUBLIC_WEB_URL: process.env.EXPO_PUBLIC_WEB_URL,
    EXPO_PUBLIC_WEB_SHELL: process.env.EXPO_PUBLIC_WEB_SHELL,
  },
  {
    isDev: typeof __DEV__ !== "undefined" && __DEV__ === true,
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- set by Expo's bundler, not a deploy var
    isWeb: process.env.EXPO_OS === "web",
  },
);

export const SHELL_ON = SHELL_CONFIG !== null && SHELL_MODE === "on";
