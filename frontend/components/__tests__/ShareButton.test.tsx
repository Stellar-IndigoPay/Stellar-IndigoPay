import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ShareButton, { donorShareText } from "../ShareButton";

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn(),
  },
});

// Mock execCommand for the fallback path
Object.defineProperty(document, "execCommand", {
  value: jest.fn(),
  writable: true,
});

describe("donorShareText", () => {
  it("formats share text with display name and XLM amount", () => {
    const text = donorShareText("Jane Doe", "1500", 3);
    expect(text).toContain("Jane Doe");
    expect(text).toContain("1,500 XLM");
    expect(text).toContain("3 climate projects");
    expect(text).toContain("@StellarIndigoPay");
  });

  it("handles singular 'project' when projectsSupported is 1", () => {
    const text = donorShareText("John", "100", 1);
    expect(text).toContain("1 climate project");
    expect(text).not.toContain("projects");
  });

  it("handles invalid XLM amount gracefully", () => {
    const text = donorShareText("Test", "abc", 0);
    expect(text).toContain("abc");
  });
});

describe("ShareButton", () => {
  const defaultProps = {
    url: "https://stellar-indigopay.app/donors/GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    text: "I donated 1,500 XLM to climate projects on @StellarIndigoPay! 🌍 Check out my impact:",
    title: "Share this donor's impact",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders Twitter, LinkedIn, and Copy link buttons", () => {
    render(<ShareButton {...defaultProps} />);

    expect(
      screen.getByRole("group", { name: "Share this profile" }),
    ).toBeInTheDocument();

    // Twitter link
    const twitterLink = screen.getByLabelText("Share on Twitter / X");
    expect(twitterLink).toBeInTheDocument();
    expect(twitterLink).toHaveAttribute(
      "href",
      expect.stringContaining("twitter.com/intent/tweet"),
    );
    expect(twitterLink).toHaveAttribute("target", "_blank");
    expect(twitterLink).toHaveAttribute("rel", "noopener noreferrer");

    // LinkedIn link
    const linkedinLink = screen.getByLabelText("Share on LinkedIn");
    expect(linkedinLink).toBeInTheDocument();
    expect(linkedinLink).toHaveAttribute(
      "href",
      expect.stringContaining("linkedin.com/sharing/share-offsite"),
    );
  });

  it("encodes URL and text parameters in share links", () => {
    render(<ShareButton {...defaultProps} />);

    const twitterLink = screen.getByLabelText("Share on Twitter / X");
    const href = twitterLink.getAttribute("href");
    expect(decodeURIComponent(href!)).toContain(defaultProps.url);
    expect(decodeURIComponent(href!)).toContain(
      defaultProps.text.slice(0, 40),
    );
  });

  it("copies URL to clipboard when Copy link is clicked", async () => {
    (navigator.clipboard.writeText as jest.Mock).mockResolvedValue(undefined);

    render(<ShareButton {...defaultProps} />);

    const copyButton = screen.getByLabelText("Copy profile link to clipboard");
    fireEvent.click(copyButton);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(defaultProps.url);

    // After clicking, should show "Copied!"
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  it("falls back to execCommand when clipboard API fails", async () => {
    (navigator.clipboard.writeText as jest.Mock).mockRejectedValue(
      new Error("denied"),
    );

    const execMock = document.execCommand as jest.Mock;
    execMock.mockReturnValue(true);

    render(<ShareButton {...defaultProps} />);

    const copyButton = screen.getByLabelText("Copy profile link to clipboard");
    fireEvent.click(copyButton);

    // Wait for the async fallback to complete
    await waitFor(() => {
      expect(execMock).toHaveBeenCalledWith("copy");
    });

    // Should show "Copied!" after successful fallback
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  it("renders without optional props", () => {
    render(<ShareButton url={defaultProps.url} />);

    expect(
      screen.getByRole("group", { name: "Share this profile" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Share on Twitter / X"),
    ).toBeInTheDocument();
  });
});
