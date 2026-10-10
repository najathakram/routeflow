import { config } from "@routeflow/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // #2257: a hook after an early return crashed the driver stop screen with React #310 while
    // this rule was only a warning. Mobile has zero violations, so it is an error from here on.
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
