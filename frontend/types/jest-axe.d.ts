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
