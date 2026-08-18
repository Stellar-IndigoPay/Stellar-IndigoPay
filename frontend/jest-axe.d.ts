/**
 * Type declarations for jest-axe.
 * jest-axe 8.0.0 does not ship its own .d.ts files.
 */
declare module "jest-axe" {
  import type { AxeResults } from "axe-core";

  export function axe(
    element: Element | string,
    options?: Record<string, unknown>,
  ): Promise<AxeResults>;

  export const toHaveNoViolations: {
    toHaveNoViolations(
      this: jest.MatcherContext,
      received: Element | string,
    ): jest.CustomMatcherResult;
  };
}
