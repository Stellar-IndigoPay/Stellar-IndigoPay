import {
  Asset,
  Horizon,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { ExtensionSettings, loadSettings } from './settings';

// Module-level vars
let API_BASE = 'https://api.stellar-indigopay.app';
let NETWORK_PASSPHRASE: string = Networks.TESTNET;
let horizonUrl = 'https://horizon-testnet.stellar.org';
let server = new Horizon.Server(horizonUrl);
let currentPublicKey: string | null = null;
let selectedProjectId: string | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let activeDropdownIndex = -1;
let dropdownItems: HTMLLIElement[] = [];

// ==================== SETTINGS APPLICATION ====================
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
  updateNetworkBadge(settings.network);
}

function updateNetworkBadge(network: 'testnet' | 'mainnet') {
  const badge = document.getElementById('network-badge');
  if (!badge) return;
  if (network === 'mainnet') {
    badge.textContent = 'Mainnet';
    badge.classList.remove('network-badge-testnet');
    badge.classList.add('network-badge-mainnet');
  } else {
    badge.textContent = 'Testnet';
    badge.classList.remove('network-badge-mainnet');
    badge.classList.add('network-badge-testnet');
  }
}

// ==================== HELPERS ====================
function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

function setStatus(msg: string, kind: 'success' | 'error' | 'info' = 'info') {
  const el = document.getElementById('status-message');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-message' + (kind === 'error' ? ' error' : kind === 'success' ? ' success' : '');
}

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

// ==================== BADGE ====================
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
  } catch (e) {
    console.error('Badge update failed:', e);
  }
}

async function saveTotalDonated(total: number) {
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ totalDonatedXLM: Math.max(0, total) }, () => {
      updateDonationBadge(total);
      resolve();
    });
  });
}

// ==================== FREIGHTER / WALLET ====================
async function connectWallet() {
  try {
    const freighter = (window as any).freighter;
    if (!freighter) {
      setStatus('Please install the Freighter wallet extension.', 'error');
      return;
    }

    const publicKey: string = await freighter.getPublicKey();
    currentPublicKey = publicKey;

    const addressEl = document.getElementById('wallet-address');
    if (addressEl) addressEl.textContent = `${publicKey.slice(0, 8)}...${publicKey.slice(-4)}`;

    const walletInfo = document.getElementById('wallet-info');
    if (walletInfo) walletInfo.classList.remove('hidden');

    const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement | null;
    if (connectBtn) {
      connectBtn.textContent = '✓ Connected';
      connectBtn.disabled = true;
    }

    const sourceInput = document.getElementById('source-address') as HTMLInputElement | null;
    if (sourceInput) sourceInput.value = publicKey;

    const profile = await fetchProfile(publicKey);
    let total = 0;
    if (profile?.data?.totalDonatedXLM) {
      total = parseFloat(profile.data.totalDonatedXLM) || 0;
    } else if (profile?.totalDonatedXLM) {
      total = parseFloat(profile.totalDonatedXLM) || 0;
    }
    await saveTotalDonated(total);
    setStatus('Wallet connected.', 'success');
  } catch (err: any) {
    console.error('Wallet connect error:', err);
    setStatus('Failed to connect wallet: ' + (err.message || 'Unknown error'), 'error');
  }
}

async function fetchProfile(publicKey: string): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}/api/profiles/${encodeURIComponent(publicKey)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ==================== PROJECT SEARCH & LIST ====================
interface ProjectResult {
  id: string;
  name: string;
  category: string;
  walletAddress?: string;
}

async function searchProjects(query: string): Promise<ProjectResult[]> {
  try {
    const res = await fetch(`${API_BASE}/api/projects?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch {
    return [];
  }
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
    li.setAttribute('role', 'option');
    li.innerHTML = `
      <div class="project-avatar" aria-hidden="true">
        <span style="font-size:18px">${getProjectEmoji(p.category)}</span>
      </div>
      <div>
        <div class="search-result-name">${escapeHtml(p.name)}</div>
        <div class="search-result-cat">${escapeHtml(p.category)}</div>
      </div>
    `;
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectProject(p);
      dropdown.classList.add('hidden');
    });
    dropdown.appendChild(li);
    dropdownItems.push(li);
  });
}

function selectProject(p: ProjectResult) {
  selectedProjectId = p.id;
  const searchInput = document.getElementById('project-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = p.name;
  const destInput = document.getElementById('destination') as HTMLInputElement | null;
  if (destInput && p.walletAddress) destInput.value = p.walletAddress;
}

function renderProjectList(projects: ProjectResult[]) {
  const list = document.getElementById('project-list');
  if (!list) return;
  list.innerHTML = '';

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
    li.setAttribute('aria-label', `${p.name}, ${p.category}`);
    li.innerHTML = `
      <div class="project-avatar" aria-hidden="true">
        <span style="font-size:20px">${getProjectEmoji(p.category)}</span>
      </div>
      <div class="project-info">
        <div class="project-name">${escapeHtml(p.name)}</div>
        <div class="project-desc">${escapeHtml(p.category)}</div>
      </div>
    `;
    li.addEventListener('click', () => selectProject(p));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectProject(p);
      }
    });
    list.appendChild(li);
  });

  const badge = document.querySelector('.section-header .badge');
  if (badge) badge.textContent = String(projects.length);
}

function debounceSearch(fn: () => void, ms: number) {
  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(fn, ms);
}

function initProjectSearch() {
  const input = document.getElementById('project-search') as HTMLInputElement | null;
  const dropdown = document.getElementById('search-dropdown') as HTMLUListElement | null;
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (!q) {
      dropdown.classList.add('hidden');
      return;
    }
    debounceSearch(async () => {
      const results = await searchProjects(q);
      renderDropdown(results, dropdown);
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (dropdownItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeDropdownIndex = Math.min(activeDropdownIndex + 1, dropdownItems.length - 1);
      highlightDropdown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeDropdownIndex = Math.max(activeDropdownIndex - 1, 0);
      highlightDropdown();
    } else if (e.key === 'Enter' && activeDropdownIndex >= 0) {
      e.preventDefault();
      dropdownItems[activeDropdownIndex]?.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      dropdown.classList.add('hidden');
    }
  });

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Node) || (input.parentElement && !input.parentElement.contains(e.target))) {
      dropdown.classList.add('hidden');
    }
  });
}

function highlightDropdown() {
  dropdownItems.forEach((el, i) => {
    el.classList.toggle('active', i === activeDropdownIndex);
  });
}

// ==================== DONATION SUBMISSION ====================
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

async function signWithFreighter(xdr: string): Promise<string> {
  const freighter = (window as any).freighter;
  if (!freighter) throw new Error('Freighter extension not found');
  return await freighter.signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE });
}

async function submitTransaction(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const result: any = await server.submitTransaction(tx as any);
  return result.hash;
}

async function sendDonation(
  source: string,
  destination: string,
  amount: string,
  memo: string,
): Promise<string> {
  const account = await server.loadAccount(source);
  const native = Asset.native();

  const txBuilder = new TransactionBuilder(account, {
    fee: String(await server.fetchBaseFee()),
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(
    Operation.payment({
      destination,
      asset: native,
      amount,
    }),
  );

  if (memo) {
    txBuilder.addMemo(Memo.text(memo));
  }

  const tx = txBuilder.setTimeout(180).build();
  const xdr = tx.toXDR();

  const signedXdr = await signWithFreighter(xdr);
  return await submitTransaction(signedXdr);
}

function updateDonateButtonState() {
  const amountInput = document.getElementById('amount') as HTMLInputElement | null;
  const destinationInput = document.getElementById('destination') as HTMLInputElement | null;
  const submit = document.getElementById('donate-submit') as HTMLButtonElement | null;
  if (!submit || !amountInput || !destinationInput) return;

  const amount = parseFloat(amountInput.value);
  const valid = !!currentPublicKey && STELLAR_ADDRESS_REGEX.test(destinationInput.value.trim()) && amount > 0;
  submit.disabled = !valid;
}

function handleDonateSubmit(e: Event) {
  e.preventDefault();
  const destination = (document.getElementById('destination') as HTMLInputElement).value.trim();
  const amount = (document.getElementById('amount') as HTMLInputElement).value.trim();
  const memo = (document.getElementById('memo') as HTMLInputElement).value.trim();

  if (!currentPublicKey) {
    setStatus('Connect your wallet first.', 'error');
    return;
  }
  if (!STELLAR_ADDRESS_REGEX.test(destination)) {
    setStatus('Destination is not a valid Stellar address.', 'error');
    return;
  }
  if (!amount || parseFloat(amount) <= 0) {
    setStatus('Enter a valid amount.', 'error');
    return;
  }

  setStatus('Awaiting signature…', 'info');
  sendDonation(currentPublicKey, destination, amount, memo)
    .then((hash) => {
      setStatus(`Sent! tx ${hash.slice(0, 8)}…`, 'success');
      chrome.storage.local.get(['totalDonatedXLM'], (res) => {
        const current = (res.totalDonatedXLM as number) || 0;
        saveTotalDonated(current + parseFloat(amount));
      });
    })
    .catch((err) => {
      console.error(err);
      setStatus(`Donate failed: ${err?.message || err}`, 'error');
    });
}

function initPresetButtons() {
  document.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const amount = btn.dataset['amount'];
      const amountInput = document.getElementById('amount') as HTMLInputElement | null;
      if (amount && amountInput) {
        amountInput.value = amount;
        updateDonateButtonState();
      }
    });
  });
}

async function handlePendingDonations() {
  const res = await new Promise<Record<string, any>>((resolve) => {
    chrome.storage.local.get(
      ['pendingDonationProjectId', 'pendingDonationAddress', 'pendingOverlayDonation'],
      (r) => resolve(r as Record<string, any>),
    );
  });

  if (res.pendingOverlayDonation) {
    chrome.storage.local.remove('pendingOverlayDonation');
    const overlay = res.pendingOverlayDonation;
    const destInput = document.getElementById('destination') as HTMLInputElement | null;
    const amountInput = document.getElementById('amount') as HTMLInputElement | null;
    const memoInput = document.getElementById('memo') as HTMLInputElement | null;
    const searchInput = document.getElementById('project-search') as HTMLInputElement | null;
    if (destInput && overlay.address) destInput.value = String(overlay.address);
    if (amountInput && overlay.amount) amountInput.value = String(overlay.amount);
    if (memoInput && overlay.memo) memoInput.value = String(overlay.memo);
    if (searchInput && overlay.label) searchInput.value = String(overlay.label);
    setStatus('Inline donate details pre-filled — review and confirm.', 'info');
    return;
  }

  if (res.pendingDonationProjectId) {
    chrome.storage.local.remove('pendingDonationProjectId');
    try {
      const response = await fetch(`${API_BASE}/api/projects/${res.pendingDonationProjectId}`);
      if (response.ok) {
        const json = await response.json();
        selectProject({
          id: json.data.id,
          name: json.data.name,
          category: json.data.category,
          walletAddress: json.data.walletAddress,
        });
      }
    } catch (err) {
      console.error('Failed to pre-fill from context menu', err);
    }
    return;
  }

  if (res.pendingDonationAddress) {
    chrome.storage.local.remove('pendingDonationAddress');
    const destInput = document.getElementById('destination') as HTMLInputElement | null;
    if (destInput) destInput.value = res.pendingDonationAddress;
  }
}

// ==================== MAIN INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await loadSettings();
  applySettings(settings);

  // Pre-fill default amount
  const amountInput = document.getElementById('amount') as HTMLInputElement | null;
  if (amountInput && settings.defaultDonationAmount) {
    amountInput.value = settings.defaultDonationAmount;
  }

  // Settings button
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      window.location.href = 'settings.html';
    });
  }

  // Connect button
  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) connectBtn.addEventListener('click', connectWallet);

  // Donation form
  const form = document.getElementById('donation-form');
  if (form) form.addEventListener('submit', handleDonateSubmit);

  // Amount/destination live validation for donate button
  ['amount', 'destination'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateDonateButtonState);
  });

  initPresetButtons();
  initProjectSearch();
  await handlePendingDonations();
  renderProjectList([]); // Will be replaced with real data once backend is wired
  updateDonateButtonState();

  console.log('🌿 IndigoPay popup initialized with inline donate support');
});
