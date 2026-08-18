/**
 * extension/src/inject/donate-overlay.ts
 *
 * Inline donate overlay — opened by the content script when a user clicks
 * "💚 Donate via IndigoPay" on a detected Stellar address.
 *
 * The overlay renders inside the host page (not in the extension popup) so
 * the user never leaves their current tab.
 */

// ── types ────────────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  name: string;
  category: string;
  verified: boolean;
  walletAddress: string;
  location?: string;
  description?: string;
  imageUrl?: string;
}

export interface DonateOverlayOptions {
  /** The Stellar address to donate to */
  address: string;
  /** Optional project info (null if no project matches the address) */
  project: ProjectInfo | null;
  /** Callback to close the overlay */
  onClose: () => void;
  /** Callback to submit a donation (amount, optional memo) */
  onDonate: (amount: string, memo?: string) => Promise<void>;
  /** Whether Freighter is available */
  freighterAvailable: boolean;
  /** The connected Freighter public key (empty if not connected) */
  freighterPublicKey: string;
  /** Connect to Freighter */
  onConnectFreighter: () => Promise<string>;
  /**
   * When true, the overlay shows a loading spinner instead of
   * the project/direct-donate view. Used when mounting the overlay
   * before the API response arrives.
   */
  isLoading?: boolean;
}

// ── overlay rendering ─────────────────────────────────────────────────

const OVERLAY_ID = "indigopay-overlay";

/**
 * Create and mount the donate overlay in the host page.
 * Returns a cleanup function that removes the overlay from the DOM.
 */
export function mountDonateOverlay(options: DonateOverlayOptions): () => void {
  // Remove any existing overlay first
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // ── render initial shell ─────────────────────────────────────────
  overlay.innerHTML = `
    <div class="igp-backdrop"></div>
    <div class="igp-modal" role="dialog" aria-label="Donate via IndigoPay">
      <button class="igp-close-btn" aria-label="Close">&times;</button>
      <div class="igp-header">
        <div class="igp-header-icon">🌿</div>
        <h3 class="igp-header-title">Donate via IndigoPay</h3>
      </div>
      <div class="igp-body">
        <div class="igp-loading">
          <div class="igp-spinner"></div>
          <span>Loading project info…</span>
        </div>
      </div>
      <div class="igp-footer">
        <span class="igp-footer-text">Powered by Stellar • 100% on-chain</span>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const bodyEl = overlay.querySelector(".igp-body") as HTMLElement;
  const closeBtn = overlay.querySelector(".igp-close-btn") as HTMLElement;
  const backdrop = overlay.querySelector(".igp-backdrop") as HTMLElement;

  // ── close handlers ───────────────────────────────────────────────
  const close = () => {
    overlay.remove();
    options.onClose();
  };

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", escHandler);

  // ── render content ───────────────────────────────────────────────
  if (options.isLoading) {
    // Keep the loading spinner from the shell HTML — don't replace body
  } else if (options.project) {
    bodyEl.innerHTML = renderProjectView(options);
    wireDonateForm(overlay, options);
  } else {
    bodyEl.innerHTML = renderDirectDonateView(options);
    wireDonateForm(overlay, options);
  }

  // Cleanup function
  return () => {
    document.removeEventListener("keydown", escHandler);
    overlay.remove();
  };
}

// ── project view ─────────────────────────────────────────────────────

function renderProjectView(opts: DonateOverlayOptions): string {
  const p = opts.project!;
  const verifiedBadge = p.verified
    ? `<span class="igp-badge igp-badge-verified">✓ Verified</span>`
    : `<span class="igp-badge igp-badge-unverified">⏳ Unverified</span>`;

  return `
    <div class="igp-project-section">
      <div class="igp-project-avatar">${getCategoryEmoji(p.category)}</div>
      <div class="igp-project-info">
        <div class="igp-project-name">${escapeHtml(p.name)}</div>
        <div class="igp-project-category">${escapeHtml(p.category)} ${verifiedBadge}</div>
        ${p.location ? `<div class="igp-project-location">📍 ${escapeHtml(p.location)}</div>` : ""}
        ${p.description ? `<p class="igp-project-desc">${escapeHtml(truncate(p.description, 120))}</p>` : ""}
      </div>
    </div>
    <div class="igp-address-row">
      <span class="igp-address-label">Receiving address</span>
      <code class="igp-address-value">${escapeHtml(truncateAddress(opts.address))}</code>
    </div>
    <hr class="igp-divider" />
    ${renderFreighterSection(opts)}
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
        ${opts.freighterPublicKey ? "💚 Confirm Donation" : "💚 Connect Wallet to Donate"}
      </button>
      <div id="igp-donate-status" class="igp-donate-status"></div>
    </div>
  `;
}

// ── direct donate view (no project match) ────────────────────────────

function renderDirectDonateView(opts: DonateOverlayOptions): string {
  return `
    <div class="igp-direct-section">
      <div class="igp-direct-icon">💳</div>
      <p class="igp-direct-text">
        This Stellar address doesn't match a registered IndigoPay project.
        You can still send a direct donation:
      </p>
      <div class="igp-address-row">
        <span class="igp-address-label">Destination</span>
        <code class="igp-address-value">${escapeHtml(truncateAddress(opts.address))}</code>
      </div>
      <button class="igp-copy-btn" data-address="${escapeHtml(opts.address)}">
        📋 Copy full address
      </button>
    </div>
    <hr class="igp-divider" />
    ${renderFreighterSection(opts)}
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
        ${opts.freighterPublicKey ? "💚 Send Donation" : "💚 Connect Wallet to Donate"}
      </button>
      <div id="igp-donate-status" class="igp-donate-status"></div>
    </div>
  `;
}

// ── Freighter section ────────────────────────────────────────────────

function renderFreighterSection(opts: DonateOverlayOptions): string {
  if (opts.freighterPublicKey) {
    return `
      <div class="igp-freighter-section">
        <div class="igp-freighter-connected">
          <span class="igp-wallet-dot"></span>
          <span>Freighter: <code>${escapeHtml(truncateAddress(opts.freighterPublicKey))}</code></span>
        </div>
      </div>
    `;
  }

  if (!opts.freighterAvailable) {
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

// ── form wiring ──────────────────────────────────────────────────────

function wireDonateForm(overlay: HTMLElement, opts: DonateOverlayOptions): void {
  const amountInput = overlay.querySelector("#igp-amount-input") as HTMLInputElement | null;
  const memoInput = overlay.querySelector("#igp-memo-input") as HTMLInputElement | null;
  const submitBtn = overlay.querySelector("#igp-submit-btn") as HTMLButtonElement | null;
  const statusEl = overlay.querySelector("#igp-donate-status") as HTMLElement | null;
  const connectBtn = overlay.querySelector("#igp-connect-freighter") as HTMLButtonElement | null;
  const copyBtn = overlay.querySelector(".igp-copy-btn") as HTMLButtonElement | null;

  // Preset buttons
  overlay.querySelectorAll(".igp-preset-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const amount = (e.currentTarget as HTMLButtonElement).dataset.amount!;
      if (amountInput) {
        amountInput.value = amount;
        updateSubmitBtn(amountInput, submitBtn, opts.freighterPublicKey);
      }
      overlay.querySelectorAll(".igp-preset-btn").forEach((b) => b.classList.remove("active"));
      (e.currentTarget as HTMLButtonElement).classList.add("active");
    });
  });

  // Custom amount input
  if (amountInput) {
    amountInput.addEventListener("input", () => {
      overlay.querySelectorAll(".igp-preset-btn").forEach((b) => b.classList.remove("active"));
      updateSubmitBtn(amountInput, submitBtn, opts.freighterPublicKey);
    });
  }

  // Connect Freighter
  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      try {
        connectBtn.textContent = "⏳ Connecting…";
        connectBtn.disabled = true;
        const pk = await opts.onConnectFreighter();
        // Re-render with connected state (simplified: update the section)
        const freighterSection = overlay.querySelector(".igp-freighter-section");
        if (freighterSection) {
          freighterSection.outerHTML = `
            <div class="igp-freighter-section">
              <div class="igp-freighter-connected">
                <span class="igp-wallet-dot"></span>
                <span>Freighter: <code>${escapeHtml(truncateAddress(pk))}</code></span>
              </div>
            </div>
          `;
        }
        updateSubmitBtn(amountInput, submitBtn, pk);
      } catch (err: any) {
        if (statusEl) {
          statusEl.textContent = `Failed to connect: ${err.message || "Unknown error"}`;
          statusEl.className = "igp-donate-status igp-status-error";
        }
        connectBtn.textContent = "🔌 Connect Freighter Wallet";
        connectBtn.disabled = false;
      }
    });
  }

  // Copy address button
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const address = copyBtn.dataset.address || "";
      try {
        await navigator.clipboard.writeText(address);
        copyBtn.textContent = "✅ Copied!";
        setTimeout(() => {
          copyBtn.textContent = "📋 Copy full address";
        }, 2000);
      } catch {
        // Fallback
        const ta = document.createElement("textarea");
        ta.value = address;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        copyBtn.textContent = "✅ Copied!";
        setTimeout(() => {
          copyBtn.textContent = "📋 Copy full address";
        }, 2000);
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
        await opts.onDonate(amountInput.value, memoInput?.value || "");
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

// ── helpers ──────────────────────────────────────────────────────────

function updateSubmitBtn(
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

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function getCategoryEmoji(category: string): string {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
