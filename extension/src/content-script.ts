/**
 * extension/src/content-script.ts
 *
 * Entry point for the Chrome content script.
 *
 * Imports the pure-logic module and wires up the auto-init, MutationObserver,
 * periodic re-scan, and message listeners. Only this file has module-level
 * side effects, so test files can import content-script-logic.ts safely.
 */

import {
  scanAndInject,
  injectDonateButton,
  overlayCleanup,
  setOverlayCleanup,
  isInsideProcessedElement,
  STELLAR_ADDRESS_RE,
} from "./content-script-logic";

// ── constants ────────────────────────────────────────────────────────

const PROCESSED_ATTR = "data-indigopay-processed";
const RESCAN_INTERVAL_MS = 3000;

// ── MutationObserver for dynamic content (SPA support) ───────────────

let mutationObserver: MutationObserver | null = null;

function createObserver(): MutationObserver {
  return new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          injectDonateButton(node as Text);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const walker = document.createTreeWalker(
            node as HTMLElement,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(n) {
                if (!n.textContent) return NodeFilter.FILTER_REJECT;
                if (
                  n.parentElement?.closest("script, style, noscript, iframe")
                ) {
                  return NodeFilter.FILTER_REJECT;
                }
                // Check ancestor chain (not just immediate parent)
                if (isInsideProcessedElement(n)) {
                  return NodeFilter.FILTER_REJECT;
                }
                STELLAR_ADDRESS_RE.lastIndex = 0;
                if (STELLAR_ADDRESS_RE.test(n.textContent)) {
                  return NodeFilter.FILTER_ACCEPT;
                }
                return NodeFilter.FILTER_REJECT;
              },
            },
          );

          let textNode: Text | null;
          while ((textNode = walker.nextNode() as Text | null)) {
            injectDonateButton(textNode);
          }
        }
      }
    }
  });
}

// ── periodic re-scan for SPA safety ──────────────────────────────────

let autoRescanTimer: ReturnType<typeof setInterval> | null = null;

function startRescanTimer(): void {
  stopRescanTimer();
  autoRescanTimer = setInterval(() => {
    scanAndInject();
  }, RESCAN_INTERVAL_MS);
}

function stopRescanTimer(): void {
  if (autoRescanTimer !== null) {
    clearInterval(autoRescanTimer);
    autoRescanTimer = null;
  }
}

// ── initialization ───────────────────────────────────────────────────

function init(): void {
  const run = () => {
    scanAndInject();

    mutationObserver = createObserver();
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    startRescanTimer();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
}

init();

window.addEventListener("beforeunload", () => {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  stopRescanTimer();
  if (overlayCleanup) {
    overlayCleanup();
    setOverlayCleanup(null);
  }
});

// ── message listener from background script ──────────────────────────

chrome.runtime.onMessage.addListener((message: any) => {
  if (message.type === "TRIGGER_RESCAN") {
    scanAndInject();
  }
  if (message.type === "CLOSE_OVERLAY") {
    if (overlayCleanup) {
      overlayCleanup();
      setOverlayCleanup(null);
    }
  }
});
