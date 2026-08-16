/**
 * Tests for message sender origin validation (issue #697).
 *
 * Only the extension's own content script and pages may drive the
 * background service worker. Messages from web pages or other extensions
 * must be rejected before any handler runs.
 */

// Importing background.ts registers its onMessage listener against the
// mocked chrome.runtime API, so we can capture and exercise the handler.
import "../background";
import { isTrustedSender } from "../sender-validation";

// Must match the `id` configured for the chrome.runtime mock in jest.setup.js.
const EXTENSION_ID = "indigopay-test-extension-id";
const VALID_ADDRESS =
  "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";

// The listener registered by background.ts via the mocked addListener.
const backgroundListener = () => {
  const mock = chrome.runtime.onMessage.addListener as jest.Mock;
  const registered = mock.mock.calls.map((call) => call[0]).filter(Boolean);
  return registered[registered.length - 1];
};

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** jsdom does not expose fetch on globalThis, so assign it directly. */
function stubFetch(): { mock: jest.Mock; restore: () => void } {
  const original = globalThis.fetch;
  const mock = jest.fn(async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  }));
  globalThis.fetch = mock as unknown as typeof fetch;
  return {
    mock,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── isTrustedSender — allowed senders ────────────────────────────────

describe("isTrustedSender allows trusted origins", () => {
  test("accepts the extension's own content script on any page", () => {
    const sender = {
      id: EXTENSION_ID,
      url: "https://example.com/arbitrary-page",
      tab: { id: 42 } as chrome.tabs.Tab,
    };
    expect(isTrustedSender(sender)).toBe(true);
  });

  test("accepts the extension's own content script on an IndigoPay page", () => {
    const sender = {
      id: EXTENSION_ID,
      url: "https://stellar-indigopay.app/projects/1",
      tab: { id: 7 } as chrome.tabs.Tab,
    };
    expect(isTrustedSender(sender)).toBe(true);
  });

  test("accepts an extension page from the chrome-extension origin", () => {
    const sender = {
      id: EXTENSION_ID,
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    };
    expect(isTrustedSender(sender)).toBe(true);
  });

  test("accepts an extension page from the moz-extension origin (Firefox)", () => {
    const sender = {
      id: EXTENSION_ID,
      url: `moz-extension://${EXTENSION_ID}/popup.html`,
    };
    expect(isTrustedSender(sender)).toBe(true);
  });
});

// ── isTrustedSender — rejected senders ───────────────────────────────

describe("isTrustedSender rejects unknown origins", () => {
  test("rejects a web page sender (no extension id)", () => {
    const sender = { url: "https://evil.example.com/" };
    expect(isTrustedSender(sender)).toBe(false);
  });

  test("rejects a sender from another extension", () => {
    const sender = {
      id: "some-other-extension-id",
      url: "https://example.com/",
      tab: { id: 3 } as chrome.tabs.Tab,
    };
    expect(isTrustedSender(sender)).toBe(false);
  });

  test("rejects an extension page from a web origin", () => {
    const sender = {
      id: EXTENSION_ID,
      url: "https://evil.example.com/popup.html",
    };
    expect(isTrustedSender(sender)).toBe(false);
  });

  test("rejects an extension page from another extension's origin", () => {
    const sender = {
      id: EXTENSION_ID,
      url: "chrome-extension://some-other-extension-id/popup.html",
    };
    expect(isTrustedSender(sender)).toBe(false);
  });

  test("rejects a sender with no id and no url", () => {
    expect(isTrustedSender({})).toBe(false);
  });

  test("rejects a sender with no url that is not a content script", () => {
    const sender = { id: EXTENSION_ID };
    expect(isTrustedSender(sender)).toBe(false);
  });
});

// ── background listener gates untrusted senders ──────────────────────

describe("background onMessage listener rejects untrusted senders", () => {
  const handler = backgroundListener();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("does not run SUBMIT_DONATION for a web page sender", () => {
    const sendResponse = jest.fn();
    handler(
      { type: "SUBMIT_DONATION", address: VALID_ADDRESS, amount: 5, memo: "" },
      { url: "https://evil.example.com/" },
      sendResponse,
    );
    expect(sendResponse).not.toHaveBeenCalled();
  });

  test("does not open the donation popup for a web page sender", () => {
    handler(
      { action: "openDonatePopup", address: VALID_ADDRESS },
      { url: "https://evil.example.com/" },
      jest.fn(),
    );
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  test("does not set project context for a sender from another extension", () => {
    handler(
      { action: "setProjectContext", projectId: "proj-1" },
      { id: "some-other-extension-id", url: "https://example.com/", tab: { id: 1 } },
      jest.fn(),
    );
    expect(chrome.contextMenus.update).not.toHaveBeenCalled();
  });

  test("does not run LOOKUP_PROJECT for a web page sender", () => {
    const { mock: fetchMock, restore } = stubFetch();
    const sendResponse = jest.fn();

    handler(
      { type: "LOOKUP_PROJECT", address: VALID_ADDRESS },
      { url: "https://evil.example.com/" },
      sendResponse,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
    restore();
  });

  test("still processes SUBMIT_DONATION from the extension's own content script", async () => {
    const sendResponse = jest.fn();
    handler(
      { type: "SUBMIT_DONATION", address: VALID_ADDRESS, amount: 5, memo: "" },
      { id: EXTENSION_ID, url: "https://example.com/", tab: { id: 9 } },
      sendResponse,
    );
    await flushPromises();
    expect(sendResponse).toHaveBeenCalledWith({ success: true, txHash: "pending" });
  });

  test("still processes LOOKUP_PROJECT from the extension's own content script", async () => {
    const { mock: fetchMock, restore } = stubFetch();
    const sendResponse = jest.fn();

    handler(
      { type: "LOOKUP_PROJECT", address: VALID_ADDRESS },
      { id: EXTENSION_ID, url: "https://example.com/", tab: { id: 9 } },
      sendResponse,
    );
    await flushPromises();

    expect(fetchMock).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ project: null });
    restore();
  });
});
