import { act, fireEvent, render, screen } from "@testing-library/react";
import InstallPrompt from "../InstallPrompt";

describe("InstallPrompt", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.matchMedia = jest.fn().mockReturnValue({ matches: false });
  });

  const createInstallEvent = () => {
    const prompt = jest.fn().mockResolvedValue(undefined);
    const event = new Event("beforeinstallprompt") as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
    };
    event.prompt = prompt;
    event.userChoice = Promise.resolve({ outcome: "accepted" });

    return { event, prompt };
  };

  it("shows the install prompt after beforeinstallprompt", () => {
    render(<InstallPrompt />);

    fireEvent(window, createInstallEvent().event);

    expect(screen.getByText(/Install Stellar IndigoPay/i)).toBeInTheDocument();
  });

  it("calls the deferred prompt when the install button is pressed", async () => {
    const { event, prompt } = createInstallEvent();
    render(<InstallPrompt />);
    fireEvent(window, event);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /install/i }));
    });

    expect(prompt).toHaveBeenCalled();
  });

  it("dismisses the prompt when the dismiss button is pressed", () => {
    render(<InstallPrompt />);

    fireEvent(window, createInstallEvent().event);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByText(/Install Stellar IndigoPay/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("indigopay-install-dismissed")).toBe(
      "true",
    );
  });
});
