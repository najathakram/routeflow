import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// findBy*/waitFor default to 1 s; give slow hosts headroom (see testTimeout in jest.config.js).
configure({ asyncUtilTimeout: 10_000 });
