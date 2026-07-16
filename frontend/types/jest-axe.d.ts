declare module "jest-axe" {
  import type { RunOptions, AxeResults } from "axe-core";

  export function axe(
    html: Element | string,
    options?: RunOptions,
  ): Promise<AxeResults>;

  export const toHaveNoViolations: {
    toHaveNoViolations(): {
      pass: boolean;
      message: () => string;
    };
  };

  export function configureAxe(
    options?: RunOptions,
  ): (html: Element | string) => Promise<AxeResults>;
}
