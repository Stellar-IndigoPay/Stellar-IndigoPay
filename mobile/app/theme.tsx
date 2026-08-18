import { createContext, useContext, ReactNode } from "react";
import { useColorScheme, ColorSchemeName } from "react-native";

export type ThemeMode = "light" | "dark";

export interface ThemeColors {
  background: string;
  surface: string;
  primary: string;
  accent: string;
  header: string;
  headerText: string;
  buttonBackground: string;
  buttonText: string;
  cardBorder: string;
  cardShadow: string;
  primaryText: string;
  secondaryText: string;
  muted: string;
  inputBackground: string;
  inputBorder: string;
  placeholder: string;
  border: string;
  statusBarStyle: "light" | "dark";
  browseText: string;
  cardBackground: string;
  unreadBackground: string;
  text: string;
}

export interface ThemeContextValue {
  mode: ThemeMode;
  colors: ThemeColors;
}

const themes: Record<ThemeMode, ThemeColors> = {
  light: {
    background: "#FAFAFE",
    surface: "#FFFFFF",
    primary: "#4F46E5",
    accent: "#3730A3",
    header: "#4F46E5",
    headerText: "#FFFFFF",
    buttonBackground: "#4F46E5",
    buttonText: "#FFFFFF",
    cardBorder: "rgba(99,102,241,0.12)",
    cardShadow: "#000000",
    primaryText: "#0F172A",
    secondaryText: "#475569",
    muted: "#94A3B8",
    inputBackground: "#FFFFFF",
    inputBorder: "rgba(99,102,241,0.18)",
    placeholder: "#94A3B8",
    border: "rgba(99,102,241,0.12)",
    statusBarStyle: "dark",
    browseText: "#FFFFFF",
    cardBackground: "#FFFFFF",
    unreadBackground: "rgba(0,128,128,0.06)",
    text: "#0F172A",
  },
  dark: {
    background: "#0A0A1A",
    surface: "#14142D",
    primary: "#818CF8",
    accent: "#A5B4FC",
    header: "#1E1B4B",
    headerText: "#E2E8F0",
    buttonBackground: "#6366F1",
    buttonText: "#FFFFFF",
    cardBorder: "rgba(129,140,248,0.14)",
    cardShadow: "#000000",
    primaryText: "#E2E8F0",
    secondaryText: "#A5B4FC",
    muted: "#64748B",
    inputBackground: "#14142D",
    inputBorder: "rgba(129,140,248,0.20)",
    placeholder: "#64748B",
    border: "rgba(129,140,248,0.14)",
    statusBarStyle: "light",
    browseText: "#E2E8F0",
    cardBackground: "#14142D",
    unreadBackground: "rgba(0,128,128,0.12)",
    text: "#E2E8F0",
  },
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const colorScheme = useColorScheme();
  const mode: ThemeMode = colorScheme === "dark" ? "dark" : "light";
  const colors = themes[mode];

  return (
    <ThemeContext.Provider value={{ mode, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

export { themes };
