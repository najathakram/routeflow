import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// findBy*/waitFor default to 1 s; give slow hosts headroom (see testTimeout in jest.config.js).
configure({ asyncUtilTimeout: 10_000 });

// Per-test isolation for sessionStorage (e.g. the settings hub remembers its search per tab).
afterEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* no DOM storage in this environment */
  }
});
