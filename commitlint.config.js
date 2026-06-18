// Conventional Commits, enforced by the .husky/commit-msg hook.
// CommonJS on purpose — the repo root has no "type": "module".
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "test",
        "ci",
        "refactor",
        "docs",
        "chore",
        "perf",
        "revert",
        "build",
        "style",
      ],
    ],
    "subject-max-length": [2, "always", 72],
    "body-max-line-length": [0],
  },
};
