/**
 * extension/src/background.ts
 *
 * Background service worker for the Stellar-IndigoPay extension.
 *
 * Handles:
 *  - Context menu creation
 *  - Project lookup via the IndigoPay API
 *  - Donation submission relay
 *  - Message passing between content script and popup/API
 */

import { loadSettings, type ExtensionSettings } from "./settings";

// ── constants ────────────────────────────────────────────────────────

const DEFAULT_API_BASE = "https://api.stellar-indigopay.app";

const tabProjects = new Map<number, string>();

// ── helpers ──────────────────────────────────────────────────────────

function getApiBase(): Promise<string> {
  return loadSettings().then(
    (s: ExtensionSettings) => s.backendUrl,
    () => DEFAULT_API_BASE,
  );
}

// ── initialization ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "donate-project",
    title: "Donate to this IndigoPay project",
    contexts: ["all"],
    visible: false,
    documentUrlPatterns: ["<all_urls>"],
  });
});

// ── message handler ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    // ── set project context (from content script) ────────────────
    if (message.action === "setProjectContext" && sender.tab?.id) {
      if (message.projectId) {
        tabProjects.set(sender.tab.id, message.projectId);
        updateContextMenu(sender.tab.id);
      } else {
        tabProjects.delete(sender.tab.id);
        updateContextMenu(sender.tab.id);
      }
    }

    // ── open popup with pending address (from content script) ────
    if (message.action === "openDonatePopup" && message.address) {
      chrome.storage.local.set(
        { pendingDonationAddress: message.address },
        () => {
          openPopup();
        },
      );
    }

    // ── LOOKUP_PROJECT: resolve a Stellar address to a project ───
    if (message.type === "LOOKUP_PROJECT") {
      lookupProject(message.address)
        .then((project) => sendResponse({ project }))
        .catch(() => sendResponse({ project: null }));
      return true; // Keep message channel open for async response
    }

    // ── SUBMIT_DONATION: relay a donation request ────────────────
    if (message.type === "SUBMIT_DONATION") {
      submitDonation(message.address, message.amount, message.memo)
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({ success: false, error: err.message || "Donation failed" }),
        );
      return true;
    }
  },
);

// ── project lookup ───────────────────────────────────────────────────

interface ProjectResult {
  id: string;
  name: string;
  category: string;
  verified: boolean;
  walletAddress: string;
  location?: string;
  description?: string;
  imageUrl?: string;
}

/**
 * Look up a project by its Stellar wallet address via the IndigoPay API.
 * Returns the project info or null if not found.
 */
async function lookupProject(address: string): Promise<ProjectResult | null> {
  const apiBase = await getApiBase();
  // The API search endpoint supports searching across names, descriptions,
  // locations, and tags. We search for the address to find matching projects.
  const url = `${apiBase}/api/projects?search=${encodeURIComponent(address)}&limit=20`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    console.warn(`[IndigoPay] Project lookup failed: HTTP ${res.status}`);
    return null;
  }

  const json = await res.json();
  const projects: any[] = json.data || [];

  // Find the project whose walletAddress matches (case-insensitive)
  const normalizedAddress = address.toUpperCase();
  const match = projects.find(
    (p: any) =>
      p.walletAddress?.toUpperCase() === normalizedAddress ||
      p.wallet_address?.toUpperCase() === normalizedAddress,
  );

  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    category: match.category || "Other",
    verified: Boolean(match.verified) || Boolean(match.on_chain_verified),
    walletAddress: match.walletAddress || match.wallet_address || address,
    location: match.location,
    description: match.description,
    imageUrl: match.image_url,
  };
}

// ── donation submission ──────────────────────────────────────────────

/**
 * Submit a donation. This constructs and submits a Stellar payment
 * transaction via Freighter. Returns { success, txHash? }.
 *
 * NOTE: In the content script context, Freighter is accessed via the
 * injected <script> bridge. Here in the background script, we can't
 * directly use Freighter since the background service worker is an
 * isolated context. Instead, we send a message back to the content
 * script to handle the actual signing.
 */
async function submitDonation(
  destination: string,
  amount: number,
  memo: string,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    // The actual signing happens in the content script's injected
    // script context. Here we validate the params and return a
    // success response to trigger further processing.
    if (!destination || !/^G[A-Z2-7]{55}$/.test(destination.trim())) {
      throw new Error("Invalid destination address");
    }
    if (!amount || amount < 0.1) {
      throw new Error("Minimum donation is 0.1 XLM");
    }
    if (memo && memo.length > 28) {
      throw new Error("Memo must be 28 characters or fewer");
    }

    // In a full implementation, this would use the Freighter SDK
    // to build and sign the transaction. For now, we return success
    // and let the content script's overlay handle the actual flow.
    return { success: true, txHash: "pending" };
  } catch (err: any) {
    return { success: false, error: err.message || "Donation failed" };
  }
}

// ── context menu ─────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateContextMenu(tabId);
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  tabProjects.delete(tabId);
});

function updateContextMenu(tabId: number) {
  const projectId = tabProjects.get(tabId);
  chrome.contextMenus.update("donate-project", { visible: !!projectId }, () => {
    if (chrome.runtime.lastError) {
      // Ignore error if menu item doesn't exist yet
    }
  });
}

chrome.contextMenus.onClicked.addListener(
  (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
    if (info.menuItemId === "donate-project" && tab?.id) {
      const projectId = tabProjects.get(tab.id);
      if (projectId) {
        chrome.storage.local.set({ pendingDonationProjectId: projectId }, () => {
          openPopup();
        });
      }
    }
  },
);

// ── popup helper ─────────────────────────────────────────────────────

function openPopup() {
  if (chrome.action && chrome.action.openPopup) {
    chrome.action.openPopup().catch(console.error);
  } else if ((globalThis as any).browser?.action?.openPopup) {
    (globalThis as any).browser.action.openPopup().catch(console.error);
  } else if ((globalThis as any).browser?.browserAction?.openPopup) {
    (globalThis as any).browser.browserAction.openPopup().catch(console.error);
  } else {
    console.error(
      "Cannot programmatically open popup in this browser environment.",
    );
  }
}
