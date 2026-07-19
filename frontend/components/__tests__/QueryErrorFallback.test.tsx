/**
 * components/__tests__/QueryErrorFallback.test.tsx
 *
 * Unit tests for the reusable inline error UI.
 *   - Correct user-facing message per error category (429 / 5xx / network / unknown).
 *   - Retry callback fires on click.
 *   - Retry button is disabled while retrying.
 *   - Retry counter renders in the button label.
 *   - Accessibility: role="alert", focusable button.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryErrorFallback } from "@/components/QueryErrorFallback";

function axiosError(status: number, code?: string) {
  return { response: { status }, code };
}

describe("QueryErrorFallback", () => {
  it("renders network error message for ERR_NETWORK", () => {
    render(
      <QueryErrorFallback error={{ code: "ERR_NETWORK" }} onRetry={() => {}} />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });

  it("renders rate-limit message for HTTP 429", () => {
    render(<QueryErrorFallback error={axiosError(429)} onRetry={() => {}} />);
    expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
  });

  it("renders server error message for HTTP 5xx", () => {
    render(<QueryErrorFallback error={axiosError(503)} onRetry={() => {}} />);
    expect(screen.getByText(/server error/i)).toBeInTheDocument();
  });

  it("renders generic message for unknown errors", () => {
    render(<QueryErrorFallback error={new Error("boom")} onRetry={() => {}} />);
    expect(screen.getByText(/failed to load data/i)).toBeInTheDocument();
  });

  it("invokes onRetry when the button is clicked", () => {
    const onRetry = jest.fn();
    render(<QueryErrorFallback error={axiosError(500)} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables the button and shows Retrying… while retrying", () => {
    render(
      <QueryErrorFallback
        error={axiosError(500)}
        onRetry={() => {}}
        isRetrying={true}
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn.textContent).toMatch(/retrying/i);
  });

  it("renders the retry counter when retryCount is supplied", () => {
    render(
      <QueryErrorFallback
        error={axiosError(500)}
        onRetry={() => {}}
        isRetrying={true}
        retryCount={2}
      />,
    );
    expect(screen.getByText(/retrying… \(attempt 2\/3\)/i)).toBeInTheDocument();
  });
});
