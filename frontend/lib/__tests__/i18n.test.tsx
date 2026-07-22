import React from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider, useI18n } from "../i18n";
import { formatNumber, formatXLM } from "../../utils/format";

function TestComponent() {
  const { t, tPlural, locale, setLocale } = useI18n();

  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="nav-home">{t("nav.home")}</span>
      <span data-testid="nav-projects">{t("nav.projects")}</span>
      <span data-testid="missing-key">{t("nonexistent.key.test")}</span>
      <span data-testid="interpolation">
        {t("nav.unreadNotifications", { count: 5 })}
      </span>
      <span data-testid="plural-one">
        {tPlural("donor.count", 1)}
      </span>
      <span data-testid="plural-other">
        {tPlural("donor.count", 5)}
      </span>
      <button data-testid="switch-fr" onClick={() => setLocale("fr")}>
        FR
      </button>
      <button data-testid="switch-es" onClick={() => setLocale("es")}>
        ES
      </button>
      <button data-testid="switch-en" onClick={() => setLocale("en")}>
        EN
      </button>
    </div>
  );
}

describe("i18n system tests", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("1. renders default English translations", () => {
    render(
      <I18nProvider>
        <TestComponent />
      </I18nProvider>
    );

    expect(screen.getByTestId("locale").textContent).toBe("en");
    expect(screen.getByTestId("nav-home").textContent).toBe("Home");
    expect(screen.getByTestId("nav-projects").textContent).toBe("Projects");
  });

  test("2. supports locale switching to FR and ES", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <TestComponent />
      </I18nProvider>
    );

    await user.click(screen.getByTestId("switch-fr"));
    expect(screen.getByTestId("locale").textContent).toBe("fr");
    expect(screen.getByTestId("nav-home").textContent).toBe("Accueil");
    expect(screen.getByTestId("nav-projects").textContent).toBe("Projets");

    await user.click(screen.getByTestId("switch-es"));
    expect(screen.getByTestId("locale").textContent).toBe("es");
    expect(screen.getByTestId("nav-home").textContent).toBe("Inicio");
    expect(screen.getByTestId("nav-projects").textContent).toBe("Proyectos");
  });

  test("3. handles missing key fallback gracefully", () => {
    render(
      <I18nProvider>
        <TestComponent />
      </I18nProvider>
    );

    expect(screen.getByTestId("missing-key").textContent).toBe("nonexistent.key.test");
  });

  test("4. performs parameter interpolation correctly", () => {
    render(
      <I18nProvider>
        <TestComponent />
      </I18nProvider>
    );

    expect(screen.getByTestId("interpolation").textContent).toBe(
      "5 unread notifications"
    );
  });

  test("5. handles singular pluralization correctly", () => {
    render(
      <I18nProvider>
        <TestComponent />
      </I18nProvider>
    );

    expect(screen.getByTestId("plural-one").textContent).toBe("1 donor");
  });

  test("6. handles plural count pluralization correctly", () => {
    render(
      <I18nProvider>
        <TestComponent />
      </I18nProvider>
    );

    expect(screen.getByTestId("plural-other").textContent).toBe("5 donors");
  });

  test("7. formatNumber formats numbers according to locale", () => {
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
    expect(formatNumber(1234567, "fr").replace(/\s/g, " ")).toMatch(/1 234 567|1234567/);
  });

  test("8. formatXLM formats XLM amounts according to locale", () => {
    expect(formatXLM(1000, "en")).toBe("1,000 XLM");
    expect(formatXLM("500.5", 2, "es")).toMatch(/500,5 XLM|500\.5 XLM/);
  });
});
