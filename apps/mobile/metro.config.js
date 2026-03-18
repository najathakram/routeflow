const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch only the shared packages directory (not the entire monorepo root,
// which would cause Metro to index all node_modules and slow startup to a crawl)
config.watchFolders = [path.resolve(workspaceRoot, "packages")];

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
