// Adds custom jest matchers like toBeInTheDocument, toHaveTextContent, etc.
import "@testing-library/jest-dom";
// jest-axe custom matcher used by accessibility tests (toHaveNoViolations).
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

// jsdom does not implement ResizeObserver; supply a minimal polyfill so that
// components using it (e.g. the embeddable widget, recharts) don't crash.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
