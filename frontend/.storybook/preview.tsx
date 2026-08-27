import React, { useEffect } from "react";
import type { Preview } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../lib/theme";
import { I18nProvider } from "../lib/i18n";
import { PriceProvider } from "../lib/priceContext";
import { WalletProvider } from "./MockWalletProvider";
import "../styles/globals.css";

if (typeof window !== "undefined") {
  (window as any).__test_publicKey__ =
    "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7";
}


function ThemeDecorator({ children, context }: { children: React.ReactNode; context: any }) {
  const theme = context.globals.theme || "light";

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  }, [theme]);

  return (
    <div className="min-h-screen bg-white text-slate-900 transition-colors duration-200 dark:bg-[#0a0a1a] dark:text-slate-100 p-4 font-body">
      {children}
    </div>
  );
}

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i } },
    a11y: {
      config: {
        rules: [{ id: "color-contrast", enabled: false }],
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
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Global theme for components",
      defaultValue: "light",
      toolbar: {
        icon: "circlehollow",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const qc = React.useMemo(() => {
        const client = new QueryClient({
          defaultOptions: {
            queries: {
              retry: false,
            },
          },
        });
        client.clear();
        return client;
      }, [context.id]);
      
      React.useEffect(() => {
        return () => qc.clear();
      }, [qc]);
      
      return (
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <I18nProvider>
            <PriceProvider>
              <WalletProvider>
                <ThemeDecorator context={context}>
                  <Story />
                </ThemeDecorator>
              </WalletProvider>
            </PriceProvider>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    )},
  ],
};

export default preview;
