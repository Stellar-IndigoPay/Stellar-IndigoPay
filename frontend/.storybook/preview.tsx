import React from "react";
import type { Preview } from "@storybook/react";
import { ThemeProvider } from "../lib/themeContext";
import { I18nProvider, useI18n } from "../lib/i18n";
import { PriceProvider } from "../lib/priceContext";
import { WalletProvider } from "./MockWalletProvider";
import "../styles/globals.css";

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i } },
    a11y: {
      config: {
        rules: [
          { id: "color-contrast", enabled: false },
        ],
      },
    },
    backgrounds: {
      default: "light",
      values: [
        { name: "light", value: "#fafafe" },
        { name: "dark", value: "#0a0a1a" },
      ],
    },
  },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <I18nProvider>
          <PriceProvider>
            <WalletProvider>
              <div className="p-4 font-body min-h-screen">
                <Story />
              </div>
            </WalletProvider>
          </PriceProvider>
        </I18nProvider>
      </ThemeProvider>
    ),
  ],
};

export default preview;
