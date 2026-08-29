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
    const { mergeConfig } = await import("vite");
    return mergeConfig(config, {
      esbuild: {
        jsx: "automatic",
      },
      resolve: {
        alias: {
          "@/lib/WalletProvider": path.resolve(
            __dirname,
            "MockWalletProvider.tsx"
          ),
          "@/": path.resolve(__dirname, "..") + "/",
          "next/link": path.resolve(__dirname, "mocks/next-link.tsx"),
          "next/router": path.resolve(__dirname, "mocks/next-router.ts"),
          "next/image": path.resolve(__dirname, "mocks/next-image.tsx"),
        },
      },
    });
  },
};

export default config;
