/**
 * Content script - GF-024 (address detection) + GF-026 (inline donate overlay)
 *
 * Walks the DOM with a TreeWalker looking for Stellar `G...` public keys.
 * - TreeWalker is O(text-nodes) and avoids recursion blow-ups.
 * - Mutation observer is debounced so we don't run during fast input typing.
 * - We mark already-processed text nodes so a node is only scanned once.
 * - We do not scan inside <script>, <style>, <noscript>, <iframe>, <input>,
 *   <textarea>, contenteditable, or our own overlay host.
 * - We also do not scan inside Shadow DOM roots, because the host page's
 *   shadow root is its own tree (and the extension's overlay is in another
 *   shadow root anyway).
 *
 * Hosts can opt out via chrome.storage.sync:
 *   `{ addressDetectionDisabled: boolean }`
 */

import { showInlineOverlay, destroyInlineOverlay } from './inline-overlay';

const STELLAR_ADDRESS_REGEX = /\bG[A-Z2-7]{55}\b/g;
const PROCESSED_ATTR = 'data-indigopay-processed';
const ARTIFICIAL_INPUT_DELAY_MS = 250;
let optOut = false;
let currentProjectId: string | null = null;
let pendingScanTimer: ReturnType<typeof setTimeout> | null = null;

initialize();

function initialize() {
  loadOptOutPref().then(() => {
    if (optOut) return;
    scan(document.body);
    observe();
    checkProjectContext();
  });
}

function loadOptOutPref(): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(['addressDetectionDisabled'], (res) => {
        optOut = !!res?.addressDetectionDisabled;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'IFRAME',
  'INPUT',
  'TEXTAREA',
  'CODE',
  'PRE',
  'OPTION',
]);

function isEditable(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as HTMLElement;
  if (SKIP_TAGS.has(el.tagName)) return true;
  if ((el as any).isContentEditable) return true;
  return false;
}

function scan(root: Node) {
  if (!root || optOut) return;
  // TreeWalker over text nodes
  const acceptNode = (node: Node): number => {
    if (!node.parentElement) return NodeFilter.FILTER_REJECT;
    if (node.parentElement.hasAttribute(PROCESSED_ATTR)) return NodeFilter.FILTER_REJECT;
    if (node.parentElement.closest(`[${PROCESSED_ATTR}]`)) return NodeFilter.FILTER_REJECT;
    // Don't process our own overlay host/contents (visible shadow root is its own tree)
    if ((node.parentElement as HTMLElement).closest?.('#indigopay-inline-overlay-host')) {
      return NodeFilter.FILTER_REJECT;
    }
    if (isEditable(node.parentElement!)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  };
  let current: Node | null = null;
  let walker: TreeWalker | null = null;
  try {
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: acceptNode as any,
    });
  } catch {
    return;
  }
  if (!walker) return;
  current = walker.nextNode();
  while (current) {
    const text = current.textContent;
    if (text && STELLAR_ADDRESS_REGEX.test(text)) {
      highlightTextNode(current as Text);
    } else if (text) {
      // Mark processed so we never re-scan this exact text on next mutation pass
      try {
        (current.parentElement as HTMLElement | null)?.setAttribute(PROCESSED_ATTR, '1');
      } catch {
        /* ignore */
      }
    }
    current = walker.nextNode();
  }
}

function highlightTextNode(textNode: Text) {
  const parent = textNode.parentNode;
  if (!parent) return;

  const text = textNode.textContent || '';
  STELLAR_ADDRESS_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const fragment = document.createDocumentFragment();
  let found = 0;

  while ((match = STELLAR_ADDRESS_REGEX.exec(text)) !== null) {
    found++;
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
    }
    fragment.appendChild(buildAddressSpan(match[0]));
    lastIndex = STELLAR_ADDRESS_REGEX.lastIndex;
  }

  if (!found) {
    (parent as HTMLElement).setAttribute(PROCESSED_ATTR, '1');
    return;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
  }

  parent.replaceChild(fragment, textNode);
  (parent as HTMLElement).setAttribute(PROCESSED_ATTR, '1');
  // Stop scanning further because we just transformed this node.
  STELLAR_ADDRESS_REGEX.lastIndex = 0;
}

function buildAddressSpan(address: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'indigopay-address';
  span.setAttribute('role', 'button');
  span.setAttribute('tabindex', '0');
  span.setAttribute('aria-label', `Donate to ${address}`);
  span.textContent = address;
  span.dataset['address'] = address;
  span.style.cssText =
    'background:linear-gradient(135deg,#4CAF50,#2E7D32);' +
    'color:white;padding:2px 6px;border-radius:4px;cursor:pointer;' +
    'font-weight:600;display:inline-block;position:relative;margin:0 2px;' +
    'transition:transform 0.15s ease;';

  const openOverlay = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = span.getBoundingClientRect();
    showInlineOverlay({ address, anchorRect: rect });
  };

  span.addEventListener('click', openOverlay);
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') openOverlay(e);
  });
  span.addEventListener('mouseenter', () => {
    span.style.transform = 'translateY(-1px)';
  });
  span.addEventListener('mouseleave', () => {
    span.style.transform = '';
  });
  return span;
}

function observe() {
  const observer = new MutationObserver((mutations) => {
    if (optOut) return;
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          // Skip our own overlay host entirely
          if ((n as Element).id === 'indigopay-inline-overlay-host') return;
          schedule(n);
        } else if (n.nodeType === Node.TEXT_NODE) {
          schedule(n.parentNode as Node);
        }
      });
    }
    checkProjectContext();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function schedule(node: Node) {
  if (!node) return;
  if (pendingScanTimer !== null) clearTimeout(pendingScanTimer);
  pendingScanTimer = setTimeout(() => {
    pendingScanTimer = null;
    try {
      scan(node);
    } catch (e) {
      console.warn('IndigoPay scan error', e);
    }
  }, ARTIFICIAL_INPUT_DELAY_MS);
}

function checkProjectContext() {
  const metaTag =
    document.querySelector('meta[name="indigopay:project:id"]') ||
    document.querySelector('meta[property="indigopay:project:id"]');
  let projectId = metaTag ? metaTag.getAttribute('content') : null;

  if (!projectId) {
    const match = window.location.pathname.match(/\/projects\/([a-zA-Z0-9_-]+)/);
    if (match) projectId = match[1];
  }

  if (projectId !== currentProjectId) {
    currentProjectId = projectId;
    try {
      chrome.runtime
        .sendMessage({ action: 'setProjectContext', projectId })
        .catch(() => {
          /* the background can be missing in dev mode */
        });
    } catch {
      /* swallow */
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  checkProjectContext();
});
window.addEventListener('popstate', checkProjectContext);

// Allow the popup to ask us to retry or refresh (e.g. after settings change).
try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === 'indigopay:rescan') {
      document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => el.removeAttribute(PROCESSED_ATTR));
      scan(document.body);
      destroyInlineOverlay();
      sendResponse?.({ ok: true });
      return true;
    }
    return false;
  });
} catch {
  /* no chrome.runtime available in tests */
}

export const __test__ = {
  STELLAR_ADDRESS_REGEX,
  PROCESSED_ATTR,
  SKIP_TAGS,
  buildAddressSpan,
  checkProjectContext,
};
