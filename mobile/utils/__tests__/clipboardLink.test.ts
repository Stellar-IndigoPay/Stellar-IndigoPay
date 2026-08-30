/**
 * utils/__tests__/clipboardLink.test.ts
 *
 * Unit tests for the clipboard-pasted-content inbound surface (#906).
 * All parsing/validation is delegated to lib/linkRouter.ts — see
 * lib/__tests__/linkRouterConvergence.test.ts for the spy-based proof of
 * that delegation. These tests cover the clipboard-specific behavior:
 * empty/unreadable clipboard, malformed content, and the
 * already-prompted de-dupe memory.
 */
import * as Clipboard from "expo-clipboard";
import {
  checkClipboardForLink,
  resetClipboardLinkMemory,
} from "../clipboardLink";

jest.mock("expo-clipboard", () => ({
  hasStringAsync: jest.fn(),
  getStringAsync: jest.fn(),
}));

const mockHasString = Clipboard.hasStringAsync as jest.Mock;
const mockGetString = Clipboard.getStringAsync as jest.Mock;

beforeEach(() => {
  mockHasString.mockReset();
  mockGetString.mockReset();
  resetClipboardLinkMemory();
});

describe("checkClipboardForLink", () => {
  test("returns null when the clipboard is empty", async () => {
    mockHasString.mockResolvedValueOnce(false);
    expect(await checkClipboardForLink()).toBeNull();
    expect(mockGetString).not.toHaveBeenCalled();
  });

  test("returns null when clipboard access throws (permissions/platform quirks)", async () => {
    mockHasString.mockRejectedValueOnce(new Error("no clipboard access"));
    expect(await checkClipboardForLink()).toBeNull();
  });

  test("returns null for whitespace-only clipboard content", async () => {
    mockHasString.mockResolvedValueOnce(true);
    mockGetString.mockResolvedValueOnce("   \n  ");
    expect(await checkClipboardForLink()).toBeNull();
  });

  test("returns null for content that doesn't parse as a link", async () => {
    mockHasString.mockResolvedValueOnce(true);
    mockGetString.mockResolvedValueOnce("just some notes, not a link");
    expect(await checkClipboardForLink()).toBeNull();
  });

  test("returns null for a malformed/disallowed-scheme link (fails closed)", async () => {
    mockHasString.mockResolvedValueOnce(true);
    mockGetString.mockResolvedValueOnce("javascript://alert(1)");
    expect(await checkClipboardForLink()).toBeNull();
  });

  test("returns the parsed result for a valid deep link", async () => {
    mockHasString.mockResolvedValueOnce(true);
    mockGetString.mockResolvedValueOnce(
      "stellar-indigopay://donate?projectId=proj-1&amount=10",
    );
    const result = await checkClipboardForLink();
    expect(result?.status).toBe("valid");
    expect(result && (result as any).target).toMatchObject({
      kind: "donate",
      projectId: "proj-1",
      amount: "10",
    });
  });

  test("returns the parsed result for a bare Stellar address", async () => {
    const address = "G" + "A".repeat(55);
    mockHasString.mockResolvedValueOnce(true);
    mockGetString.mockResolvedValueOnce(address);
    const result = await checkClipboardForLink();
    expect(result?.status).toBe("valid");
  });

  test("does not re-prompt for the exact same clipboard content twice in a row", async () => {
    const link = "stellar-indigopay://donate?projectId=proj-1";
    mockHasString.mockResolvedValue(true);
    mockGetString.mockResolvedValue(link);

    const first = await checkClipboardForLink();
    expect(first?.status).toBe("valid");

    const second = await checkClipboardForLink();
    expect(second).toBeNull();
  });

  test("prompts again once the clipboard content changes", async () => {
    mockHasString.mockResolvedValue(true);
    mockGetString.mockResolvedValueOnce("stellar-indigopay://donate?projectId=proj-1");
    const first = await checkClipboardForLink();
    expect(first?.status).toBe("valid");

    mockGetString.mockResolvedValueOnce("stellar-indigopay://donate?projectId=proj-2");
    const second = await checkClipboardForLink();
    expect(second?.status).toBe("valid");
    expect((second as any).target.projectId).toBe("proj-2");
  });

  test("resetClipboardLinkMemory allows re-prompting for the same value", async () => {
    const link = "stellar-indigopay://donate?projectId=proj-1";
    mockHasString.mockResolvedValue(true);
    mockGetString.mockResolvedValue(link);

    await checkClipboardForLink();
    resetClipboardLinkMemory();
    const again = await checkClipboardForLink();
    expect(again?.status).toBe("valid");
  });
});
