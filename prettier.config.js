// Single source of truth for Prettier across the entire monorepo.
// All apps and packages inherit these settings.

/** @type {import("prettier").Config} */
const config = {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  endOfLine: "lf",
};

module.exports = config;
