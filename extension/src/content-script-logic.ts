/**
 * extension/src/content-script-logic.ts
 *
 * Pure logic for Stellar address detection, donate button injection,
 * overlay handling, and Freighter wallet integration.
 *
 * This module has NO module-level side effects so it can be imported
 * safely in tests.
 */

import { mountDonateOverlay, type ProjectInfo } from "./inject/donate-overlay";

// ── constants ────────────────────────────────────────────────────────

export const STELLAR_ADDRESS_RE = /\bG[A-Z2-7]{55}\b/g;

/** CSS class added to parent elements that contain a detected address. */
const DETECTED_CLASS = "indigopay-detected-address";

/** Attribute set on already-processed elements to prevent duplicates. */
const PROCESSED_ATTR = "data-indigopay-processed";

/**
 * Interval (ms) at which we re-scan the DOM for new addresses.
 * This handles SPA pages that mutate the DOM without navigation.
 */
const RESCAN_INTERVAL_MS = 3000;

// ── state ────────────────────────────────────────────────────────────

export let overlayCleanup: (() => void) | null = null;

export function setOverlayCleanup(fn: (() => void) | null): void {
  overlayCleanup = fn;
}

export let rescanTimer: ReturnType<typeof setInterval> | null = null;

export let observer: MutationObserver | null = null;

// ── address detection ────────────────────────────────────────────────

/**
 * Check whether a node is inside an element that has already been processed
 * (has the PROCESSED_ATTR attribute at any ancestor level up to body).
 */
export function isInsideProcessedElement(node: Node): boolean {
  let el = node.parentElement;
  while (el && el !== document.body) {
    if (el.hasAttribute(PROCESSED_ATTR)) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Walk the DOM tree and return text nodes that contain a Stellar address.
 */
export function findAddressTextNodes(): Text[] {
  const matches: Text[] = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest("script, style, noscript, iframe")) {
          return NodeFilter.FILTER_REJECT;
        }
        // Check ancestor chain (not just immediate parent) to prevent
        // re-scanning text nodes inside highlighted spans and donate buttons.
        if (isInsideProcessedElement(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        STELLAR_ADDRESS_RE.lastIndex = 0;
        if (STELLAR_ADDRESS_RE.test(node.textContent)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      },
    },
  );

  const nodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    nodes.push(node);
  }
  return nodes;
}

/**
 * Extract unique Stellar addresses from a text node.
 */
export function extractAddresses(textNode: Text): string[] {
  const text = textNode.textContent || "";
  const addresses: string[] = [];
  STELLAR_ADDRESS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STELLAR_ADDRESS_RE.exec(text)) !== null) {
    addresses.push(match[0]);
  }
  return [...new Set(addresses)];
}

// ── DOM injection ────────────────────────────────────────────────────

/**
 * Inject donate buttons next to detected Stellar addresses within a
 * given text node. The text node is replaced with a DocumentFragment
 * that preserves the surrounding text.
 */
export function injectDonateButton(textNode: Text): void {
  const parent = textNode.parentElement;
  if (!parent) return;

  // Mark as processed so we don't re-process on re-scans
  if (!parent.hasAttribute(PROCESSED_ATTR)) {
    parent.setAttribute(PROCESSED_ATTR, "true");
  }

  const text = textNode.textContent || "";
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  STELLAR_ADDRESS_RE.lastIndex = 0;

  while ((match = STELLAR_ADDRESS_RE.exec(text)) !== null) {
    // Text before the address
    if (match.index > lastIndex) {
      fragment.appendChild(
        document.createTextNode(text.substring(lastIndex, match.index)),
      );
    }

    const address = match[0];

    // Wrapper span for the address with subtle highlight
    const addressSpan = document.createElement("span");
    addressSpan.className = DETECTED_CLASS;
    addressSpan.textContent = address;
    addressSpan.style.cssText = `
      background: rgba(79, 70, 229, 0.08);
      border-bottom: 1px dashed rgba(79, 70, 229, 0.3);
      cursor: pointer;
      border-radius: 2px;
      padding: 0 2px;
      transition: background 0.15s ease;
    `;
    addressSpan.addEventListener("mouseenter", () => {
      addressSpan.style.background = "rgba(79, 70, 229, 0.15)";
    });
    addressSpan.addEventListener("mouseleave", () => {
      addressSpan.style.background = "rgba(79, 70, 229, 0.08)";
    });

    fragment.appendChild(addressSpan);

    // Donate button
    const btn = createDonateButton(address);
    fragment.appendChild(btn);

    lastIndex = STELLAR_ADDRESS_RE.lastIndex;
  }

  // Remaining text after the last address
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
  }

  if (textNode.parentNode) {
    textNode.parentNode.replaceChild(fragment, textNode);
  }
}

/**
 * Create a "💚 Donate via IndigoPay" button for a given address.
 */
export function createDonateButton(address: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "indigopay-donate-btn";
  btn.dataset.address = address;
  btn.setAttribute("data-indigopay-address", address);

  btn.innerHTML = "💚 Donate via IndigoPay";

  btn.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0 4px;
    padding: 3px 10px;
    background: linear-gradient(135deg, #4F46E5, #6366F1);
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    vertical-align: middle;
    line-height: 1.4;
    white-space: nowrap;
    transition: all 0.15s ease;
    box-shadow: 0 1px 3px rgba(79, 70, 229, 0.3);
    opacity: 0.9;
  `;

  btn.addEventListener("mouseenter", () => {
    btn.style.opacity = "1";
    btn.style.boxShadow = "0 2px 8px rgba(79, 70, 229, 0.4)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.opacity = "0.9";
    btn.style.boxShadow = "0 1px 3px rgba(79, 70, 229, 0.3)";
  });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDonateClick(address);
  });

  return btn;
}

// ── overlay handling ─────────────────────────────────────────────────

/**
 * Open the donate overlay for a given Stellar address.
 *
 * Mounts the overlay **immediately** with a loading state, then fetches
 * project info from the background script and updates the body in-place
 * (no re-mount) once the API responds.
 */
export function handleDonateClick(address: string): void {
  // Remove any existing overlay
  if (overlayCleanup) {
    overlayCleanup();
    setOverlayCleanup(null);
  }

  const freighterAvailable = typeof (window as any).freighter !== "undefined";

  // Mount overlay immediately with a loading spinner
  const cleanup = mountDonateOverlay({
    address,
    project: null,
    isLoading: true,
    onClose: () => {
      setOverlayCleanup(null);
    },
    onDonate: async (amount: string, memo?: string) => {
      return handleDonateSubmit(address, parseFloat(amount), memo);
    },
    freighterAvailable,
    freighterPublicKey: "",
    onConnectFreighter: async () => {
      return connectFreighter();
    },
  });
  setOverlayCleanup(cleanup);

  // Fetch project info from background (async — updates overlay in-place)
  chrome.runtime.sendMessage(
    { type: "LOOKUP_PROJECT", address },
    (response: { project?: ProjectInfo | null }) => {
      const project = response?.project || null;
      const overlay = document.getElementById("indigopay-overlay");
      if (!overlay) return;

      const bodyEl = overlay.querySelector(".igp-body") as HTMLElement;
      if (!bodyEl) return;

      // Replace the body content with the project/direct-donate view
      const { renderProjectViewStr, renderDirectDonateViewStr } =
        buildBodyContent(address, project, freighterAvailable, "");

      bodyEl.innerHTML = project
        ? renderProjectViewStr
        : renderDirectDonateViewStr;

      // Wire up the new form elements inside the updated body
      wireBodyEvents(overlay, address, project, "");
    },
  );
}

/**
 * Submit a donation by forwarding the request to the background script.
 */
export async function handleDonateSubmit(
  address: string,
  amount: number,
  memo?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "SUBMIT_DONATION",
        address,
        amount,
        memo: memo || "",
      },
      (response: { success?: boolean; error?: string; txHash?: string }) => {
        if (response?.success) {
          resolve();
        } else {
          reject(new Error(response?.error || "Donation failed"));
        }
      },
    );
  });
}

/**
 * Connect to Freighter wallet via the injected bridge script.
 */
export async function connectFreighter(): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.textContent = `
      (async function() {
        try {
          const freighter = window.freighter;
          if (!freighter || typeof freighter.getPublicKey !== 'function') {
            throw new Error('Freighter not available');
          }
          const publicKey = await freighter.getPublicKey();
          window.postMessage({
            source: 'indigopay-extension',
            type: 'FREIGHTER_CONNECTED',
            publicKey: publicKey
          }, '*');
        } catch (err) {
          window.postMessage({
            source: 'indigopay-extension',
            type: 'FREIGHTER_ERROR',
            error: err.message || 'Failed to connect'
          }, '*');
        }
      })();
    `;
    document.body.appendChild(script);
    script.remove();

    const handler = (event: MessageEvent) => {
      if (event.data?.source !== "indigopay-extension") return;
      if (event.data.type === "FREIGHTER_CONNECTED") {
        window.removeEventListener("message", handler);
        resolve(event.data.publicKey);
      } else if (event.data.type === "FREIGHTER_ERROR") {
        window.removeEventListener("message", handler);
        reject(new Error(event.data.error));
      }
    };
    window.addEventListener("message", handler);

    setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Freighter connection timed out"));
    }, 10000);
  });
}

// ── full page scan ───────────────────────────────────────────────────

/**
 * Scan the entire document body and inject donate buttons for all
 * detected Stellar addresses.
 */
export function scanAndInject(): void {
  const textNodes = findAddressTextNodes();
  for (const node of textNodes) {
    injectDonateButton(node);
  }
}

// ── build body content ───────────────────────────────────────────────

/**
 * Build the HTML strings for the overlay body content.
 * Returns both views so the caller can pick which to render.
 */
export function buildBodyContent(
  address: string,
  project: ProjectInfo | null,
  freighterAvailable: boolean,
  freighterPublicKey: string,
): { renderProjectViewStr: string; renderDirectDonateViewStr: string } {
  const directView = `
    <div class="igp-direct-section">
      <div class="igp-direct-icon">💳</div>
      <p class="igp-direct-text">
        This Stellar address doesn't match a registered IndigoPay project.
        You can still send a direct donation:
      </p>
      <div class="igp-address-row">
        <span class="igp-address-label">Destination</span>
        <code class="igp-address-value">${escapeHtml(truncateAddress(address))}</code>
      </div>
      <button class="igp-copy-btn" data-address="${escapeHtml(address)}">
        📋 Copy full address
      </button>
    </div>
    <hr class="igp-divider" />
    ${freighterSectionHTML(freighterAvailable, freighterPublicKey)}
    <div class="igp-donate-form">
      <label class="igp-field-label" for="igp-amount-input">Amount (XLM)</label>
      <div class="igp-amount-row">
        <div class="igp-presets">
          <button class="igp-preset-btn" data-amount="1">1</button>
          <button class="igp-preset-btn" data-amount="5">5</button>
          <button class="igp-preset-btn" data-amount="10">10</button>
          <button class="igp-preset-btn" data-amount="50">50</button>
        </div>
        <div class="igp-input-wrapper">
          <input type="number" id="igp-amount-input" class="igp-amount-input"
                 min="0.1" step="0.1" placeholder="Custom" autocomplete="off" />
          <span class="igp-currency-label">XLM</span>
        </div>
      </div>
      <label class="igp-field-label" for="igp-memo-input">Memo (optional)</label>
      <input type="text" id="igp-memo-input" class="igp-memo-input"
             placeholder="e.g. Thanks for the great work!" maxlength="28" />
      <button id="igp-submit-btn" class="igp-submit-btn" disabled>
        ${freighterPublicKey ? "💚 Send Donation" : "💚 Connect Wallet to Donate"}
      </button>
      <div id="igp-donate-status" class="igp-donate-status"></div>
    </div>
  `;

  if (!project) {
    return { renderProjectViewStr: "", renderDirectDonateViewStr: directView };
  }

  const verifiedBadge = project.verified
    ? `<span class="igp-badge igp-badge-verified">✓ Verified</span>`
    : `<span class="igp-badge igp-badge-unverified">⏳ Unverified</span>`;

  const projectView = `
    <div class="igp-project-section">
      <div class="igp-project-avatar">${getCategoryEmoji(project.category)}</div>
      <div class="igp-project-info">
        <div class="igp-project-name">${escapeHtml(project.name)}</div>
        <div class="igp-project-category">${escapeHtml(project.category)} ${verifiedBadge}</div>
        ${project.location ? `<div class="igp-project-location">📍 ${escapeHtml(project.location)}</div>` : ""}
        ${project.description ? `<p class="igp-project-desc">${escapeHtml(truncateStr(project.description, 120))}</p>` : ""}
      </div>
    </div>
    <div class="igp-address-row">
      <span class="igp-address-label">Receiving address</span>
      <code class="igp-address-value">${escapeHtml(truncateAddress(address))}</code>
    </div>
    <hr class="igp-divider" />
    ${freighterSectionHTML(freighterAvailable, freighterPublicKey)}
    <div class="igp-donate-form">
      <label class="igp-field-label" for="igp-amount-input">Amount (XLM)</label>
      <div class="igp-amount-row">
        <div class="igp-presets">
          <button class="igp-preset-btn" data-amount="1">1</button>
          <button class="igp-preset-btn" data-amount="5">5</button>
          <button class="igp-preset-btn" data-amount="10">10</button>
          <button class="igp-preset-btn" data-amount="50">50</button>
        </div>
        <div class="igp-input-wrapper">
          <input type="number" id="igp-amount-input" class="igp-amount-input"
                 min="0.1" step="0.1" placeholder="Custom" autocomplete="off" />
          <span class="igp-currency-label">XLM</span>
        </div>
      </div>
      <label class="igp-field-label" for="igp-memo-input">Memo (optional)</label>
      <input type="text" id="igp-memo-input" class="igp-memo-input"
             placeholder="e.g. Thank you for your work!" maxlength="28" />
      <button id="igp-submit-btn" class="igp-submit-btn" disabled>
        ${freighterPublicKey ? "💚 Confirm Donation" : "💚 Connect Wallet to Donate"}
      </button>
      <div id="igp-donate-status" class="igp-donate-status"></div>
    </div>
  `;

  return { renderProjectViewStr: projectView, renderDirectDonateViewStr: directView };
}

/**
 * Wire up event listeners on form elements inside the overlay body.
 */
export function wireBodyEvents(
  overlayEl: HTMLElement,
  address: string,
  _project: ProjectInfo | null,
  freighterPublicKey: string,
): void {
  // _project is kept for API consistency — the direct-donate vs project
  // view is built by buildBodyContent, not by wireBodyEvents
  const amountInput = overlayEl.querySelector("#igp-amount-input") as HTMLInputElement | null;
  const memoInput = overlayEl.querySelector("#igp-memo-input") as HTMLInputElement | null;
  const submitBtn = overlayEl.querySelector("#igp-submit-btn") as HTMLButtonElement | null;
  const statusEl = overlayEl.querySelector("#igp-donate-status") as HTMLElement | null;
  const connectBtn = overlayEl.querySelector("#igp-connect-freighter") as HTMLButtonElement | null;
  const copyBtn = overlayEl.querySelector(".igp-copy-btn") as HTMLButtonElement | null;

  // Preset buttons
  overlayEl.querySelectorAll(".igp-preset-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const amount = (e.currentTarget as HTMLButtonElement).dataset.amount!;
      if (amountInput) {
        amountInput.value = amount;
        updateSubmitBtn(amountInput, submitBtn, freighterPublicKey);
      }
      overlayEl.querySelectorAll(".igp-preset-btn").forEach((b) => b.classList.remove("active"));
      (e.currentTarget as HTMLButtonElement).classList.add("active");
    });
  });

  // Custom amount input
  if (amountInput) {
    amountInput.addEventListener("input", () => {
      overlayEl.querySelectorAll(".igp-preset-btn").forEach((b) => b.classList.remove("active"));
      updateSubmitBtn(amountInput, submitBtn, freighterPublicKey);
    });
  }

  // Connect Freighter
  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      try {
        connectBtn.textContent = "⏳ Connecting…";
        connectBtn.disabled = true;
        const pk = await connectFreighter();
        const freighterSectionEl = overlayEl.querySelector(".igp-freighter-section");
        if (freighterSectionEl) {
          freighterSectionEl.outerHTML = freighterSectionHTML(true, pk);
        }
        updateSubmitBtn(amountInput, submitBtn, pk);
      } catch (err: any) {
        if (statusEl) {
          statusEl.textContent = `Failed to connect: ${err.message || "Unknown error"}`;
          statusEl.className = "igp-donate-status igp-status-error";
        }
        if (connectBtn) {
          connectBtn.textContent = "🔌 Connect Freighter Wallet";
          connectBtn.disabled = false;
        }
      }
    });
  }

  // Copy address button
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const addr = copyBtn.dataset.address || "";
      try {
        await navigator.clipboard.writeText(addr);
        copyBtn.textContent = "✅ Copied!";
        setTimeout(() => { copyBtn.textContent = "📋 Copy full address"; }, 2000);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = addr;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        copyBtn.textContent = "✅ Copied!";
        setTimeout(() => { copyBtn.textContent = "📋 Copy full address"; }, 2000);
      }
    });
  }

  // Submit donation
  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      if (!amountInput || !amountInput.value || parseFloat(amountInput.value) < 0.1) {
        if (statusEl) {
          statusEl.textContent = "Minimum donation is 0.1 XLM.";
          statusEl.className = "igp-donate-status igp-status-error";
        }
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "⏳ Processing…";
      if (statusEl) {
        statusEl.textContent = "";
        statusEl.className = "igp-donate-status";
      }

      try {
        await handleDonateSubmit(address, parseFloat(amountInput.value), memoInput?.value || "");
        if (statusEl) {
          statusEl.textContent = "✅ Donation submitted successfully!";
          statusEl.className = "igp-donate-status igp-status-success";
        }
        submitBtn.textContent = "✅ Done";
      } catch (err: any) {
        if (statusEl) {
          statusEl.textContent = `❌ ${err.message || "Transaction failed"}`;
          statusEl.className = "igp-donate-status igp-status-error";
        }
        submitBtn.disabled = false;
        submitBtn.textContent = "💚 Try Again";
      }
    });
  }
}

// ── inline helpers ───────────────────────────────────────────────────

export function freighterSectionHTML(
  available: boolean,
  publicKey: string,
): string {
  if (publicKey) {
    return `
      <div class="igp-freighter-section">
        <div class="igp-freighter-connected">
          <span class="igp-wallet-dot"></span>
          <span>Freighter: <code>${escapeHtml(truncateAddress(publicKey))}</code></span>
        </div>
      </div>
    `;
  }
  if (!available) {
    return `
      <div class="igp-freighter-section">
        <p class="igp-freighter-missing">
          ⚠️ <a href="https://freighter.app" target="_blank" rel="noopener">Freighter wallet</a>
          extension not detected. Install it to donate.
        </p>
      </div>
    `;
  }
  return `
    <div class="igp-freighter-section">
      <button id="igp-connect-freighter" class="igp-connect-btn">
        🔌 Connect Freighter Wallet
      </button>
    </div>
  `;
}

export function updateSubmitBtn(
  amountInput: HTMLInputElement | null,
  submitBtn: HTMLButtonElement | null,
  publicKey: string,
): void {
  if (!submitBtn) return;
  const hasAmount = amountInput && amountInput.value && parseFloat(amountInput.value) >= 0.1;
  submitBtn.disabled = !hasAmount || !publicKey;
  submitBtn.textContent = publicKey
    ? (hasAmount ? "💚 Confirm Donation" : "Enter an amount")
    : "💚 Connect Wallet to Donate";
}

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function truncateStr(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

export function getCategoryEmoji(category: string): string {
  const map: Record<string, string> = {
    Reforestation: "🌳",
    "Solar Energy": "☀️",
    "Ocean Conservation": "🌊",
    "Clean Water": "💧",
    "Wildlife Protection": "🦁",
    "Carbon Capture": "♻️",
    "Wind Energy": "💨",
    "Sustainable Agriculture": "🌾",
  };
  return map[category] ?? "🌿";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
