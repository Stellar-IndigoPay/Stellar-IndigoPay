import { renderHook } from "@testing-library/react";
import useShortcuts from "../useShortcuts";

describe("useShortcuts", () => {
  let originalAddEventListener: typeof window.addEventListener;
  let originalRemoveEventListener: typeof window.removeEventListener;

  beforeAll(() => {
    originalAddEventListener = window.addEventListener;
    originalRemoveEventListener = window.removeEventListener;
  });

  afterAll(() => {
    window.addEventListener = originalAddEventListener;
    window.removeEventListener = originalRemoveEventListener;
  });

  it("should register keydown listener and clean up on unmount", () => {
    const addSpy = jest.spyOn(window, "addEventListener");
    const removeSpy = jest.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useShortcuts([]));

    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("should trigger handler for basic key without modifiers", () => {
    const handler = jest.fn();
    renderHook(() => useShortcuts([{ key: "p", handler, description: "Print page" }]));

    const event = new KeyboardEvent("keydown", { key: "p" });
    window.dispatchEvent(event);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should trigger handler with exact modifiers (meta/cmd)", () => {
    const handler = jest.fn();
    renderHook(() => useShortcuts([{ key: "k", meta: true, handler, description: "Search" }]));

    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true });
    window.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should trigger handler with exact modifiers (ctrl)", () => {
    const handler = jest.fn();
    renderHook(() => useShortcuts([{ key: "d", ctrl: true, handler, description: "Dashboard" }]));

    const event = new KeyboardEvent("keydown", { key: "d", ctrlKey: true });
    window.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should not trigger handler when user is typing in an input, textarea, or contenteditable", () => {
    const handler = jest.fn();
    renderHook(() => useShortcuts([{ key: "k", meta: true, handler, description: "Search" }]));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
    });
    input.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();

    const div = document.createElement("div");
    div.contentEditable = "true";
    document.body.appendChild(div);
    div.focus();
    div.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();

    document.body.removeChild(input);
    document.body.removeChild(textarea);
    document.body.removeChild(div);
  });

  it("should handle case insensitivity for keys", () => {
    const handler = jest.fn();
    renderHook(() => useShortcuts([{ key: "K", handler, description: "Test case" }]));

    const event = new KeyboardEvent("keydown", { key: "k" });
    window.dispatchEvent(event);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
