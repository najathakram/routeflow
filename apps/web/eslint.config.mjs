import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/** @type {import("eslint").Linter.Config[]} */
const config = [
  // `next/core-web-vitals` only — the rule set apps/web has actually been linted
  // with all along (Next 14's `next lint` ignored this flat config and read
  // `.eslintrc.json`). Next 15's `next lint` discovers flat config first, so this
  // file is now live; adding `next/typescript` here would newly surface ~360
  // @typescript-eslint errors and is a separate piece of work, not part of the
  // Next 15 upgrade.
  ...compat.extends("next/core-web-vitals"),
  {
    rules: {
      // Enforce consistent import order
      "no-console": "warn",
    },
  },
];

export default config;
