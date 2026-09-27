const path = require("path");
const Module = require("module");

// #2312: babel-preset-expo probes for expo-router with require.resolve FROM ITS OWN LOCATION (the
// hoisted root node_modules), but npm nests expo-router under apps/mobile/node_modules, off that
// walk-up path. The preset then silently skips its router plugin and the bundle dies with
// "Invalid call at line 2: process.env.EXPO_ROUTER_APP_ROOT". eas.json used to paper over this
// with a hard-coded Linux NODE_PATH (/home/expo/...), which is wrong on the macOS iOS workers
// (/Users/expo/...), so the first iOS store build failed at "Bundle JavaScript".
// Fix it path-independently: add THIS workspace's node_modules (from __dirname) to Node's global
// resolution paths before the preset loads. Babel evaluates this file in every Metro transform
// worker, so it holds on EAS Linux and macOS workers, locally, and in the web Docker build.
/** Pure: NODE_PATH with `<appDir>/node_modules` first, unchanged when it is already present. */
function withAppNodeModules(currentNodePath, appDir) {
  const appNodeModules = path.join(appDir, "node_modules");
  const parts = (currentNodePath || "").split(path.delimiter).filter(Boolean);
  return parts.includes(appNodeModules)
    ? currentNodePath
    : [appNodeModules, ...parts].join(path.delimiter);
}

const nextNodePath = withAppNodeModules(process.env.NODE_PATH, __dirname);
if (nextNodePath !== process.env.NODE_PATH) {
  process.env.NODE_PATH = nextNodePath;
  Module._initPaths();
}

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // Transform import.meta to {} so zustand/middleware works in Metro web builds
      // (Zustand v5 uses import.meta.env in its devtools middleware)
      ({ types: t }) => ({
        visitor: {
          MetaProperty(path) {
            if (
              t.isIdentifier(path.node.meta, { name: "import" }) &&
              t.isIdentifier(path.node.property, { name: "meta" })
            ) {
              path.replaceWith(t.objectExpression([]));
            }
          },
        },
      }),
    ],
  };
};

module.exports.withAppNodeModules = withAppNodeModules;
