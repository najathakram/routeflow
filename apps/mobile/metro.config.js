const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Metro can only bundle files that live under a watched root. npm hoists most
// mobile deps (expo-router, react-native, expo, …) up to the workspace-root
// node_modules, so Metro must watch that folder too — otherwise `expo export`
// fails with "Unable to resolve module ./node_modules/expo-router/entry".
// We watch the shared packages and the root node_modules specifically (not the
// whole monorepo root) so Metro still skips apps/web + apps/api sources.
config.watchFolders = [
  path.resolve(workspaceRoot, "packages"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Resolve modules from workspace root first
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Map @routeflow package subpath exports that Metro can't resolve via exports field
const routeflowExports = {
  "@routeflow/ui": path.resolve(workspaceRoot, "packages/ui/index.tsx"),
  "@routeflow/ui/mobile": path.resolve(workspaceRoot, "packages/ui/src/mobile/index.ts"),
  "@routeflow/ui/web": path.resolve(workspaceRoot, "packages/ui/src/web/index.ts"),
  "@routeflow/ui/tokens": path.resolve(workspaceRoot, "packages/ui/src/tokens.ts"),
  "@routeflow/types": path.resolve(workspaceRoot, "packages/types/index.ts"),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (routeflowExports[moduleName]) {
    return { filePath: routeflowExports[moduleName], type: "sourceFile" };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
