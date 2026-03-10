// Re-export the base ESLint config for use in packages that don't need
// React or Next.js rules (e.g. packages/types, packages/config itself).
export { config as default } from "@routeflow/eslint-config/base";
