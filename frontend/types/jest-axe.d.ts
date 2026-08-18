/**
 * types/jest-axe.d.ts
 *
 * Ambient type declarations for the `jest-axe` package which ships without
 * its own `.d.ts`. The jest-setup registers `toHaveNoViolations` globally so
 * the matcher is available everywhere; per-test imports only need the
 * `axe()` runner helper.
 */
declare module "jest-axe" {
  export interface AxeViolation {
    id: string;
    impact?: "minor" | "moderate" | "serious" | "critical" | null;
    description: string;
    help: string;
    helpUrl?: string;
    nodes: Array<{ html: string; target: string[]; failureSummary?: string }>;
  }

  export interface AxeResults {
    violations: AxeViolation[];
    passes: AxeViolation[];
    incomplete: AxeViolation[];
    inapplicable: AxeViolation[];
    url: string;
    timestamp: string;
  }

  export function axe(
    container: Element | string,
    options?: Record<string, unknown>,
  ): Promise<AxeResults>;

  export const toHaveNoViolations: () => void;
}

/**
 * Register the custom matcher on Jest's global Matchers interface so
 * `expect(results).toHaveNoViolations()` type-checks in test files.
 * (jest.setup.ts wires the runtime implementation via expect.extend.)
 */
declare namespace jest {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Matchers<R> {
    toHaveNoViolations(): R;
  }
}
