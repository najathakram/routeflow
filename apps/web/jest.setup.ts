import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// findBy*/waitFor default to 1 s; give slow hosts headroom (see testTimeout in jest.config.js).
configure({ asyncUtilTimeout: 10_000 });

// Per-test isolation for history.state (e.g. the settings hub keeps its search on its own history entry).
afterEach(() => {
  try {
    window.history.replaceState(null, "");
  } catch {
    /* no DOM in this environment */
  }
});
