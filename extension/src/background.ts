/**
 * Background script - service worker
 * Routes messages from the popup and content scripts and mediates
 * the lifecycle of the action button (popup), context menu, and inline
 * donate overlay in the content script.
 */

const tabProjects = new Map<number, string>();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'donate-project',
    title: 'Donate to this IndigoPay project',
    contexts: ['all'],
    visible: false,
    documentUrlPatterns: ['*://*/*'],
  });
});

chrome.runtime.onMessage.addListener((message: any, sender: chrome.runtime.MessageSender) => {
  if (message.action === "setProjectContext" && sender.tab?.id) {
    if (message.projectId) {
      tabProjects.set(sender.tab.id, message.projectId);
    } else {
      tabProjects.delete(sender.tab.id);
    }
    updateContextMenu(sender.tab.id);
    return false;
  }

  // User clicked an inline-detected address in the content script — open
  // the popup so Freighter + Stellar tx can be initiated from there.
  if (message.action === 'openDonatePopup' && message.address) {
    chrome.storage.local.set({ pendingDonationAddress: message.address }, () => {
      openPopup();
      sendResponse?.({ ok: true });
    });
    return true; // we will respond asynchronously
  }

  // The inline overlay collected a full intent (address + amount + memo)
  // and wants the popup to be opened with the form pre-filled.
  if (message.action === 'saveOverlayDonation' && message.payload?.address) {
    chrome.storage.local.set(
      {
        pendingOverlayDonation: {
          address: String(message.payload.address),
          amount: String(message.payload.amount ?? ''),
          memo: String(message.payload.memo ?? ''),
          label: String(message.payload.label ?? ''),
          ts: Date.now(),
        },
      },
      () => {
        openPopup();
        sendResponse?.({ ok: true });
      },
    );
    return true;
  }

  // Liveness signal — used by the options/popup to wake the SW.
  if (message.action === 'ping') {
    sendResponse?.({ ok: true, pong: Date.now() });
    return false;
  }

  return false;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateContextMenu(tabId);
});

chrome.tabs.onUpdated.addListener((tabId: number, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    // The content script will re-evaluate and send 'setProjectContext',
    // but we can ensure it's hidden during navigation if desired.
  }
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  tabProjects.delete(tabId);
});

function updateContextMenu(tabId: number) {
  const projectId = tabProjects.get(tabId);
  chrome.contextMenus.update('donate-project', { visible: !!projectId }, () => {
    if (chrome.runtime.lastError) {
      // Ignore "menu not yet created" errors during cold-start.
    }
  });
}

chrome.contextMenus.onClicked.addListener((info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
  if (info.menuItemId === "donate-project" && tab?.id) {
    const projectId = tabProjects.get(tab.id);
    if (projectId) {
      chrome.storage.local.set({ pendingDonationProjectId: projectId }, () => {
        openPopup();
      });
    }
  }
});

// Best-effort open of the action's popup. openPopup is not available in
// Firefox (use a window.open fallback) and may be undefined when the SW
// is initializing — we swallow those errors and log a warning instead.
function openPopup() {
  try {
    if (chrome.action && chrome.action.openPopup) {
      chrome.action.openPopup().catch((err) => {
        console.warn('IndigoPay: action.openPopup failed:', err);
      });
      return;
    }
  } catch (e) {
    // fall through
  }
  try {
    const firefoxApi: any = (globalThis as any).browser;
    if (firefoxApi?.action?.openPopup) {
      firefoxApi.action.openPopup().catch(console.error);
      return;
    }
    if (firefoxApi?.browserAction?.openPopup) {
      firefoxApi.browserAction.openPopup().catch(console.error);
      return;
    }
  } catch {
    // fall through
  }
  console.warn(
    'IndigoPay: Cannot programmatically open the popup in this environment. ' +
      'User must click the toolbar icon.',
  );
}

export {};
