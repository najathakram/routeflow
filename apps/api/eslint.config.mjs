// @ts-check
import eslint from "@eslint/js";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "eslint.config.mjs",
      "**/*.spec.ts",
      "**/*.test.ts",
      "**/*-spec.ts",
      "test/",
      "prisma.config.ts",
      "dist/",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: "commonjs",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      // Formatting is enforced deterministically by `prettier --check` (the
      // pre-commit hook + `npm run format`). Keeping prettier as an eslint ERROR
      // double-enforced it via eslint-plugin-prettier, whose config resolution
      // drifts from standalone prettier in CI and flagged correctly-formatted
      // union types as errors — failing CI Lint on code prettier is happy with.
      // Downgraded to a warning so CI Lint reflects real code issues, not that drift.
      "prettier/prettier": ["warn", { endOfLine: "auto" }],
    },
  },
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^(deleteMany|updateMany)$/][arguments.length=0]",
          message: "B126: unscoped bulk write. Pass { where: { tenantId } }.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(deleteMany|updateMany)$/] > ObjectExpression[properties.length=0]",
          message: "B126: deleteMany({}) deletes EVERY tenant's rows.",
        },
      ],
    },
  },
);
