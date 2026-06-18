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
