import React from "react";

// Adds custom jest matchers like toBeInTheDocument, toHaveTextContent, etc.
import "@testing-library/jest-dom";
// jest-axe custom matcher used by accessibility tests (toHaveNoViolations).
// The package ships without first-party types; the ambient shim at
// `frontend/types/jest-axe.d.ts` exposes the runtime shape. Use an `any` cast
// because jest's internal ExpectExtendMap type is private.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations as any);

// ── JSDOM polyfills ─────────────────────────────────────────────────────
// jsdom does not implement ResizeObserver or a layout engine, so
// el.offsetParent is always null. Polyfill both so components and
// focus-trap logic work correctly in tests.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
global.ResizeObserver = class ResizeObserver {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  observe() {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  unobserve() {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  disconnect() {}
};

Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  get() {
    // jsdom lacks a layout engine, so every element's offsetParent is
    // null by default.  Return the parentNode when the element is
    // connected to the DOM; null otherwise (matching real behaviour
    // for detached elements and display:none).
    return this.isConnected ? this.parentNode : null;
  },
});

// ── Mock next/image ─────────────────────────────────────────────────────
// jsdom cannot resolve next/image's optimized image loading; replace it with
// a simple <img> render that preserves className, alt, src, and data-testid.
// Uses React.createElement to avoid JSX in a setup file.
jest.mock(
  "next/image",
  () =>
    function MockNextImage({
      src,
      alt = "",
      className,
      priority,
      loading,
      fill,
      sizes,
      ...rest
    }: {
      src: string;
      alt?: string;
      className?: string;
      priority?: boolean;
      loading?: "lazy" | "eager";
      fill?: boolean;
      sizes?: string;
      [key: string]: unknown;
    }) {
      return React.createElement("img", {
        src,
        alt: alt || "",
        className,
        "data-priority": priority ? "true" : undefined,
        "data-loading": loading,
        "data-fill": fill ? "true" : undefined,
        "data-sizes": sizes,
        ...rest,
      });
    },
);
