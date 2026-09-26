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
const appNodeModules = path.join(__dirname, "node_modules");
const nodePath = (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean);
if (!nodePath.includes(appNodeModules)) {
  process.env.NODE_PATH = [appNodeModules, ...nodePath].join(path.delimiter);
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
