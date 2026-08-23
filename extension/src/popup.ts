import {
  Asset,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { loadSettings, type ExtensionSettings } from './settings';
import { apiFetch, ApiClientError, type BreakerState } from './lib/apiClient';
import { renderApiStatusBanner, breakerEventTypeToState } from './lib/apiStatusBanner';

// Module-level vars
let API_BASE = 'https://api.stellar-indigopay.app';
let NETWORK_PASSPHRASE: string = Networks.TESTNET;
let horizonUrl = 'https://horizon-testnet.stellar.org';
let server = new Horizon.Server(horizonUrl);

function applySettings(settings: ExtensionSettings) {
  API_BASE = settings.backendUrl;
  if (settings.network === 'mainnet') {
    NETWORK_PASSPHRASE = Networks.PUBLIC;
    horizonUrl = 'https://horizon.stellar.org';
  } else {
    NETWORK_PASSPHRASE = Networks.TESTNET;
    horizonUrl = 'https://horizon-testnet.stellar.org';
  }
  server = new Horizon.Server(horizonUrl);
}

// ==================== BADGE HELPERS ====================
function abbreviateNumber(num: number): string {
  if (num < 1000) return Math.floor(num).toString();
  if (num < 1000000) return Math.floor(num / 1000) + 'K';
  return (num / 1000000).toFixed(1) + 'M';
}

async function updateDonationBadge(totalXLM: number) {
  const text = abbreviateNumber(totalXLM);
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    console.log(`[IndigoPay Badge] Updated: ${text} (${totalXLM} XLM)`);
  } catch (e) {
    console.error('Badge update failed:', e);
  }
}

async function signWithFreighter(xdr: string): Promise<string> {
  const freighter = (window as any).freighter;
  if (!freighter) throw new Error('Freighter extension not found');

  const signedXdr: string = await freighter.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  return signedXdr;
}

async function submitTransaction(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const result = await server.submitTransaction(tx as any);
  return (result as any).hash;
}

// --- Project search autocomplete ---

interface ProjectResult {
  id: string;
  name: string;
  category: string;
  walletAddress?: string;
}

/** HTML-escape a string to prevent XSS in rendered content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Set a status message in the popup UI (success or error). */
function setStatus(message: string, isError = false): void {
  const el = document.getElementById('status-message');
  if (!el) return;
  el.textContent = message;
  el.className = isError ? 'status error' : 'status success';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

/** Initialize the project search autocomplete input. */
function initProjectSearch(): void {
  const searchInput = document.getElementById('project-search') as HTMLInputElement | null;
  if (!searchInput) return;

  const dropdown = document.getElementById('search-dropdown') as HTMLUListElement | null;
  if (!dropdown) return;

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    if (query.length < 2) {
      dropdown.classList.add('hidden');
      return;
    }
    debounce(async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/projects?search=${encodeURIComponent(query)}&limit=5`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const projects: ProjectResult[] = (json.data || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          walletAddress: p.walletAddress,
        }));
        renderDropdown(projects, dropdown!);
      } catch {
        dropdown.classList.add('hidden');
      }
    }, 300);
  });

  searchInput.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.add('hidden'), 200);
  });
}

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let activeDropdownIndex = -1;
let dropdownItems: HTMLLIElement[] = [];
let selectedProjectId: string | null = null;

// --- Project list keyboard navigation ---

let projectListItems: HTMLLIElement[] = [];
let activeProjectListIndex = -1;

/**
 * Render a list of projects into the #project-list element and wire up
 * keyboard navigation (ArrowDown/Up, Enter, Escape).
 *
 * Keyboard contract (issue #489):
 *   ArrowDown  — move focus to the next project item
 *   ArrowUp    — move focus to the previous project item
 *   Enter      — open the focused project in a new tab or trigger donation
 *   Escape     — close the popup window
 */
function renderProjectList(projects: ProjectResult[]) {
  const list = document.getElementById('project-list') as HTMLUListElement | null;
  if (!list) return;

  list.innerHTML = '';
  projectListItems = [];
  activeProjectListIndex = -1;

  if (projects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'glass-panel project-item';
    empty.textContent = 'No saved projects yet.';
    list.appendChild(empty);
    return;
  }

  projects.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'glass-panel project-item';
    li.setAttribute('tabindex', '0');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-label', `${escapeHtml(p.name)}, ${escapeHtml(p.category)}`);
    li.innerHTML = `
      <div class="project-avatar" aria-hidden="true">
        <span style="font-size:20px">${getProjectEmoji(p.category)}</span>
      </div>
      <div class="project-info">
        <div class="project-name">${escapeHtml(p.name)}</div>
        <div class="project-desc">${escapeHtml(p.category)}</div>
      </div>
    `;

    // Mouse click — select this project for donation
    li.addEventListener('click', () => {
      selectProjectListItem(li, p);
    });

    // Allow keyboard activation via Enter/Space
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectProjectListItem(li, p);
      }
    });

    list.appendChild(li);
    projectListItems.push(li);
  });

  // Update badge count
  const badge = document.querySelector('.section-header .badge');
  if (badge) badge.textContent = String(projects.length);
}

function selectProjectListItem(li: HTMLLIElement, p: ProjectResult) {
  // Highlight the selected item
  projectListItems.forEach((el) => el.classList.remove('active'));
  li.classList.add('active');

  // Pre-fill the destination address field
  const destInput = document.getElementById('destination') as HTMLInputElement | null;
  const searchInput = document.getElementById('project-search') as HTMLInputElement | null;
  if (p.walletAddress && destInput) {
    destInput.value = p.walletAddress;
    selectedProjectId = p.id;
  }
  if (searchInput) {
    searchInput.value = p.name;
  }
}

function highlightProjectListItem(index: number) {
  projectListItems.forEach((el, i) => {
    if (i === index) {
      el.classList.add('active');
      el.focus();
    } else {
      el.classList.remove('active');
    }
  });
}

/** Map a project category to a representative emoji. */
function getProjectEmoji(category: string): string {
  const map: Record<string, string> = {
    'Reforestation': '🌳',
    'Solar Energy': '☀️',
    'Ocean Conservation': '🌊',
    'Clean Water': '💧',
    'Wildlife Protection': '🦁',
    'Carbon Capture': '♻️',
    'Wind Energy': '💨',
    'Sustainable Agriculture': '🌾',
  };
  return map[category] ?? '🌿';
}

function initProjectListKeyNav() {
  const list = document.getElementById('project-list') as HTMLUListElement | null;
  if (!list) return;

  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Saved projects');

  list.addEventListener('keydown', (e) => {
    if (projectListItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeProjectListIndex = Math.min(
        activeProjectListIndex + 1,
        projectListItems.length - 1,
      );
      highlightProjectListItem(activeProjectListIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeProjectListIndex = Math.max(activeProjectListIndex - 1, 0);
      highlightProjectListItem(activeProjectListIndex);
    } else if (e.key === 'Enter' && activeProjectListIndex >= 0) {
      projectListItems[activeProjectListIndex]?.click();
    } else if (e.key === 'Escape') {
      window.close();
    }
  });
}

// ==================== API DEGRADED-STATE BANNER ====================
//
// Reflects the shared background circuit breaker state (see
// extension/src/lib/apiClient.ts and background.ts's GET_API_STATUS /
// API_STATUS_CHANGED messages) without ever blocking the donate flow —
// donations are signed and submitted directly via Freighter/Horizon, so
// an API outage only means degraded project sync, not a broken donate
// button. The state->copy/DOM mapping lives in lib/apiStatusBanner.ts so
// it stays unit-testable independent of this file's stellar-sdk import.

function getApiStatusBannerElements() {
  const banner = document.getElementById('api-status-banner') as HTMLElement | null;
  const text = document.getElementById('api-status-text') as HTMLElement | null;
  const retryButton = document.getElementById('api-status-retry') as HTMLButtonElement | null;
  if (!banner || !text) return null;
  return { banner, text, retryButton };
}

function applyApiStatus(state: BreakerState | null): void {
  const elements = getApiStatusBannerElements();
  if (!elements) return;
  renderApiStatusBanner(elements, state);
}

function requestApiStatus(userInitiated = false): void {
  // A user-initiated Retry click needs to actually attempt an API call —
  // merely re-reading the breaker snapshot can't advance a tripped
  // breaker, since only a real request acquires a half-open trial slot
  // (see background.ts's retryApiConnection). Passive init/polling only
  // needs the snapshot.
  const messageType = userInitiated ? 'RETRY_API_CONNECTION' : 'GET_API_STATUS';
  chrome.runtime.sendMessage({ type: messageType }, (response) => {
    if (chrome.runtime.lastError) return;
    const status = response?.status ?? null;
    applyApiStatus(status?.state ?? null);

    // A user-initiated Retry click while the breaker is still open (the
    // trial above failed, or no trial slot was available) gets the exact
    // same "open" state back, which on its own looks like the click did
    // nothing. Tell them how much longer the cooldown has so the control
    // gives visible feedback instead of silently re-rendering.
    if (userInitiated && status?.state === 'open') {
      const elements = getApiStatusBannerElements();
      if (elements) {
        const seconds = Math.max(0, Math.ceil((status.retryAfterMs ?? 0) / 1000));
        elements.text.textContent =
          seconds > 0
            ? `Still degraded — retrying automatically in ${seconds}s. Donations still work.`
            : 'API degraded — retrying automatically. Donations still work.';
      }
    }
  });
}

function initApiStatusBanner(): void {
  // Pull current state on popup open (background may already know).
  requestApiStatus();

  // Live updates while the popup stays open.
  chrome.runtime.onMessage.addListener((message: any) => {
    if (message?.type === 'API_STATUS_CHANGED') {
      applyApiStatus(breakerEventTypeToState(message.event?.type));
    }
  });

  const elements = getApiStatusBannerElements();
  elements?.retryButton?.addEventListener('click', () => requestApiStatus(true));
}

function debounce(fn: () => void, ms: number) {
  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(fn, ms);
}

function renderDropdown(projects: ProjectResult[], dropdown: HTMLUListElement) {
  dropdown.innerHTML = '';
  dropdownItems = [];
  activeDropdownIndex = -1;

  if (projects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'search-no-results';
    empty.textContent = 'No projects found';
    dropdown.appendChild(empty);
    dropdown.classList.remove('hidden');
    return;
  }

  projects.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div class="search-result-name">${escapeHtml(p.name)}</div>
        <div class="search-result-cat">${escapeHtml(p.category)}</div>
      </div>
    `;
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const destInput = document.getElementById('destination') as HTMLInputElement | null;
      const searchInput = document.getElementById('project-search') as HTMLInputElement | null;
      if (p.walletAddress && destInput) {
        destInput.value = p.walletAddress;
        selectedProjectId = p.id;
      }
      if (searchInput) {
        searchInput.value = p.name;
      }
      dropdown.classList.add('hidden');
    });
  });
}

async function saveTotalDonated(total: number) {
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ totalDonatedXLM: Math.max(0, total) }, () => {
      updateDonationBadge(total);
      resolve();
    });
  });
}

async function updateTotalAfterDonation(amount: number) {
  chrome.storage.local.get(['totalDonatedXLM'], async (result) => {
    const current = (result.totalDonatedXLM as number) || 0;
    await saveTotalDonated(current + amount);
  });
}

// ==================== PROFILE API ====================
async function fetchProfile(publicKey: string): Promise<any> {
  try {
    const res = await apiFetch(`${API_BASE}/api/profiles/${encodeURIComponent(publicKey)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof ApiClientError) {
      console.warn(`Profile fetch unavailable (${e.category}) — using local storage fallback`);
    } else {
      console.warn('Profile fetch failed (using local storage fallback):', e);
    }
    return null;
  }
}

// ==================== WALLET CONNECT ====================
let currentPublicKey: string | null = null;

async function connectWallet() {
  try {
    const freighter = (window as any).freighter;
    if (!freighter) {
      alert('Please install the Freighter wallet extension.');
      return;
    }

    const publicKey = await freighter.getPublicKey();
    currentPublicKey = publicKey;

    // UI Updates
    const addressEl = document.getElementById('wallet-address') as HTMLSpanElement | null;
    if (addressEl) addressEl.textContent = `${publicKey.slice(0, 8)}...${publicKey.slice(-4)}`;

    const walletInfo = document.getElementById('wallet-info') as HTMLElement | null;
    if (walletInfo) walletInfo.classList.remove('hidden');

    const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement | null;
    if (connectBtn) {
      connectBtn.textContent = '✓ Connected';
      connectBtn.disabled = true;
    }

    // Fetch total donated from backend
    const profile = await fetchProfile(publicKey);
    let total = 0;
    if (profile?.data?.totalDonatedXLM || profile?.totalDonatedXLM) {
      total = parseFloat(profile.data?.totalDonatedXLM || profile.totalDonatedXLM) || 0;
    }
    await saveTotalDonated(total);

  } catch (err: any) {
    console.error('Wallet connect error:', err);
    alert('Failed to connect wallet: ' + (err.message || 'Unknown error'));
  }
}

// ==================== DONATION HELPERS (keep your existing ones) ====================
// buildDonationTransaction, signWithFreighter, submitTransaction, recordDonation, etc.

// After successful donation in your submit handler, add:
// await updateTotalAfterDonation(parseFloat(amount));

// ==================== MAIN INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await loadSettings();
  applySettings(settings);

  // Pre-fill donation amount from saved default
  const amountInput = document.getElementById('custom-amount-input') as HTMLInputElement | null;
  if (amountInput && settings.defaultDonationAmount) {
    amountInput.value = settings.defaultDonationAmount;
  }

  // Wire settings button
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      window.location.href = 'settings.html';
    });
  }

  initProjectSearch();
  initProjectListKeyNav();
  initApiStatusBanner();

  // Check for pending context-menu donation
  chrome.storage.local.get(['pendingDonationProjectId', 'pendingDonationAddress'], async (res) => {
    if (res.pendingDonationProjectId) {
      chrome.storage.local.remove('pendingDonationProjectId');
      try {
        const response = await apiFetch(`${API_BASE}/api/projects/${res.pendingDonationProjectId}`);
        if (response.ok) {
          const json = await response.json();
          const projectData = json.data;
          
          const destInput = document.getElementById('destination') as HTMLInputElement | null;
          const searchInput = document.getElementById('project-search') as HTMLInputElement | null;
          
          if (destInput && projectData.walletAddress) {
            destInput.value = projectData.walletAddress;
            selectedProjectId = projectData.id;
          }
          if (searchInput && projectData.name) {
            searchInput.value = projectData.name;
          }
        }
      } catch (err) {
        console.error('Failed to pre-fill project from context menu', err);
      }
    } else if (res.pendingDonationAddress) {
      chrome.storage.local.remove('pendingDonationAddress');
      const destInput = document.getElementById('destination') as HTMLInputElement | null;
      if (destInput) {
        destInput.value = res.pendingDonationAddress as string;
      }
    }
  });

  const form = document.getElementById('donation-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    try {
      e.preventDefault();
      const sourceAddress = ((document.getElementById('source-address') as HTMLInputElement)?.value ?? '').trim();
      const destination = ((document.getElementById('destination') as HTMLInputElement)?.value ?? '').trim();
      const amount = ((document.getElementById('amount') as HTMLInputElement)?.value ?? '').trim();
      const memo = ((document.getElementById('memo') as HTMLInputElement)?.value ?? '').trim();

      if (!sourceAddress || !destination || !amount) {
        setStatus('Please fill in all required fields.', true);
        return;
      }
    } catch {
      // Silently ignore — the skeleton loader remains visible
    }
  });

  // Connect button
  const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement | null;
  if (connectBtn) connectBtn.addEventListener('click', connectWallet);

  console.log('🌿 IndigoPay Extension initialized with donation badge (#490)');
});