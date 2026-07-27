/**
 * Storybook 8 main configuration for the Stellar-IndigoPay frontend.
 *
 * Uses @storybook/react-vite (Vite builder) instead of @storybook/nextjs
 * because @storybook/nextjs inherits the Next.js webpack config which
 * includes withSentryConfig — the Sentry webpack plugin's DefinePlugin
 * conflicts with Storybook's own webpack instance. Vite avoids the issue
 * entirely and builds significantly faster.
 *
 * Next.js-specific modules (next/link, next/router, next/image) are
 * mocked via Vite aliases. The real @/lib/WalletProvider (which depends
 * on the Freighter browser extension) is aliased to a mock.
 */
import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";

const config: StorybookConfig = {
  stories: ["../components/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-a11y",
    "@storybook/addon-themes",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  staticDirs: ["../public"],
  docs: {
    autodocs: "tag",
  },
  async viteFinal(config) {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@": path.resolve(__dirname, ".."),
      // Mock Next.js modules that aren't available outside the Next.js runtime
      "next/link": path.resolve(__dirname, "mocks/next-link.tsx"),
      "next/router": path.resolve(__dirname, "mocks/next-router.ts"),
      "next/image": path.resolve(__dirname, "mocks/next-image.tsx"),
      // Redirect WalletProvider to the mock so components don't try to
      // connect to the real Freighter browser extension. Monkey-patching
      // ESM exports does not work, so we use a Vite alias instead.
      "@/lib/WalletProvider": path.resolve(
        __dirname,
        "MockWalletProvider.tsx",
      ),
    };

    return config;
  },
};

export default config;
