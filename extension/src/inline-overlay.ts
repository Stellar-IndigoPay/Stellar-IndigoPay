/**
 * Inline Donate Overlay - GF-026
 *
 * A floating glassmorphic donate card that is injected next to a detected
 * Stellar address on the active page. Encapsulated in a Shadow DOM so that
 * page CSS cannot leak in (and we don't leak out onto the page).
 *
 * The card only collects the donation *intent* (address + amount + memo).
 * Actual signing/submission still happens in the extension popup so we
 * can re-use the Freighter wallet connection logic.
 */

const HOST_ID = 'indigopay-inline-overlay-host';
const PRESETS = ['1', '5', '10'];

const CARD_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.ip-card {
  position: fixed;
  z-index: 2147483647;
  width: 280px;
  background: rgba(11, 15, 25, 0.94);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(99, 102, 241, 0.35);
  border-radius: 14px;
  padding: 14px;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  color: #fff;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  animation: ipPop 180ms cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: top left;
}
@keyframes ipPop {
  from { opacity: 0; transform: translateY(-4px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.ip-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 10px;
}
.ip-title {
  font-size: 13px; font-weight: 700; letter-spacing: 0.02em;
  background: linear-gradient(135deg, #818cf8, #6366f1);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
  display: flex; align-items: center; gap: 6px;
}
.ip-close {
  background: transparent; border: none; color: #94a3b8; cursor: pointer;
  font-size: 16px; padding: 2px 4px; border-radius: 6px;
  transition: background 0.15s ease;
}
.ip-close:hover { background: rgba(255,255,255,0.08); color: #fff; }
.ip-addr {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px; color: #94a3b8;
  background: rgba(0, 0, 0, 0.4);
  padding: 4px 8px; border-radius: 6px;
  margin-bottom: 10px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ip-presets {
  display: flex; gap: 6px; margin-bottom: 8px;
}
.ip-preset {
  flex: 1;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  color: #fff;
  border-radius: 7px;
  padding: 7px 0; font-size: 12px; font-weight: 600;
  cursor: pointer; transition: all 0.15s ease;
  font-family: inherit;
}
.ip-preset:hover { background: rgba(255,255,255,0.12); }
.ip-preset.active {
  background: rgba(99,102,241,0.2);
  border-color: rgba(99,102,241,0.5);
}
.ip-row {
  display: flex; gap: 6px; align-items: center; margin-bottom: 10px;
}
.ip-input {
  flex: 1;
  background: rgba(0,0,0,0.35);
  border: 1px solid rgba(255,255,255,0.1);
  color: #fff;
  border-radius: 7px;
  padding: 7px 10px 7px 10px;
  font-size: 12.5px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s ease;
}
.ip-input:focus { border-color: #6366f1; }
.ip-suffix {
  font-size: 11px; color: #94a3b8;
}
.ip-memo {
  width: 100%;
  background: rgba(0,0,0,0.35);
  border: 1px solid rgba(255,255,255,0.1);
  color: #fff;
  border-radius: 7px;
  padding: 7px 10px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  margin-bottom: 10px;
  transition: border-color 0.15s ease;
}
.ip-memo:focus { border-color: #6366f1; }
.ip-donate {
  width: 100%;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 9px 0;
  font-weight: 600;
  font-size: 12.5px;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.1s ease;
  font-family: inherit;
}
.ip-donate:hover:not(:disabled) { filter: brightness(1.08); }
.ip-donate:active:not(:disabled) { transform: translateY(1px); }
.ip-donate:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  filter: grayscale(0.6);
}
.ip-toast {
  margin-top: 8px;
  font-size: 11px;
  text-align: center;
  color: #94a3b8;
  min-height: 14px;
}
.ip-error { color: #f87171; }
.ip-success { color: #10b981; }
`;

export interface OverlayOptions {
  /** Stellar public key (G...) shown in the card and used as destination */
  address: string;
  /** Anchor rectangle (typically address span .getBoundingClientRect()) */
  anchorRect: { left: number; top: number; width: number; height: number };
  /** Optional human label, e.g. project name; falls back to truncated address */
  label?: string;
  /** Optional pre-selected amount */
  amount?: string;
  /** Optional memo text (≤ 28 bytes) */
  memo?: string;
}

export interface OverlayHandle {
  host: HTMLElement;
  destroy: () => void;
  setStatus: (msg: string, kind?: 'info' | 'error' | 'success') => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncate(addr: string, head = 6, tail = 6): string {
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * Renders the inline donate overlay and returns a handle with destroy().
 * Safe to call only once per anchor — pass OverlayOptions each time.
 */
export function showInlineOverlay(opts: OverlayOptions): OverlayHandle | null {
  if (!opts?.address || !/^G[A-Z2-7]{55}$/.test(opts.address)) return null;

  // Remove any pre-existing overlay first to avoid stacking.
  destroyInlineOverlay();

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Keep the host itself invisible so it doesn't trigger our own highlight pass.
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:auto;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CARD_CSS;
  shadow.appendChild(style);

  const card = document.createElement('div');
  card.className = 'ip-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'IndigoPay inline donate');
  shadow.appendChild(card);

  const header = document.createElement('div');
  header.className = 'ip-header';
  header.innerHTML = `
    <div class="ip-title">🌿 IndigoPay</div>
    <button class="ip-close" type="button" aria-label="Close donate overlay">✕</button>
  `;
  card.appendChild(header);

  const addrEl = document.createElement('div');
  addrEl.className = 'ip-addr';
  addrEl.textContent = truncate(opts.address);
  addrEl.title = opts.address;
  card.appendChild(addrEl);

  const presetsEl = document.createElement('div');
  presetsEl.className = 'ip-presets';
  presetsEl.setAttribute('role', 'group');
  presetsEl.setAttribute('aria-label', 'Quick amounts');
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ip-preset';
    btn.dataset['amount'] = p;
    btn.textContent = `${p} XLM`;
    btn.addEventListener('click', () => {
      amountInput.value = p;
      presetsEl.querySelectorAll('.ip-preset').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      setDonateEnabled();
    });
    presetsEl.appendChild(btn);
  });
  card.appendChild(presetsEl);

  const row = document.createElement('div');
  row.className = 'ip-row';
  row.innerHTML = `
    <input class="ip-input" type="number" min="0.0000001" step="0.1"
      placeholder="Custom" aria-label="Custom donation amount" />
    <span class="ip-suffix">XLM</span>
  `;
  card.appendChild(row);
  const amountInput = row.querySelector('.ip-input') as HTMLInputElement;

  const memo = document.createElement('input');
  memo.className = 'ip-memo';
  memo.type = 'text';
  memo.placeholder = 'Memo (optional, ≤ 28 bytes)';
  memo.maxLength = 28;
  if (opts.memo) memo.value = opts.memo;
  card.appendChild(memo);

  const donate = document.createElement('button');
  donate.type = 'button';
  donate.className = 'ip-donate';
  donate.textContent = 'Donate';
  donate.setAttribute('aria-label', 'Donate to this address');
  card.appendChild(donate);

  const toast = document.createElement('div');
  toast.className = 'ip-toast';
  toast.setAttribute('role', 'status');
  card.appendChild(toast);

  // Initial values
  if (opts.amount) {
    amountInput.value = opts.amount;
    const match = Array.from(presetsEl.querySelectorAll<HTMLButtonElement>('.ip-preset'))
      .find((b) => b.dataset['amount'] === opts.amount);
    if (match) match.classList.add('active');
  }

  // Position the card relative to the address anchor, clamped to viewport.
  const margin = 8;
  const cardWidth = 280;
  const cardHeight = 220; // approximate; varies slightly

  const left = clamp(
    opts.anchorRect.left + opts.anchorRect.width / 2 - cardWidth / 2,
    margin,
    window.innerWidth - cardWidth - margin,
  );

  // Default below the address; flip above if there's not enough room.
  const wouldOverflowBottom = opts.anchorRect.top + opts.anchorRect.height + cardHeight + margin > window.innerHeight;
  const top = wouldOverflowBottom
    ? clamp(opts.anchorRect.top - cardHeight - margin, margin, window.innerHeight - cardHeight - margin)
    : clamp(opts.anchorRect.top + opts.anchorRect.height + margin, margin, window.innerHeight - cardHeight - margin);

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;

  function setDonateEnabled() {
    const amt = parseFloat(amountInput.value);
    donate.disabled = !(amt > 0);
  }
  setDonateEnabled();
  amountInput.addEventListener('input', setDonateEnabled);

  function setStatus(msg: string, kind: 'info' | 'error' | 'success' = 'info') {
    toast.textContent = msg;
    toast.classList.remove('ip-error', 'ip-success');
    if (kind === 'error') toast.classList.add('ip-error');
    if (kind === 'success') toast.classList.add('ip-success');
  }

  function close() {
    host.remove();
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll, true);
  }

  function onDocClick(ev: Event) {
    if (!host.contains(ev.target as Node) && ev.composedPath().indexOf(host) === -1) {
      close();
    }
  }

  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
    }
  }

  function reposition() {
    close();
  }
  function onResize() {
    // Repositioning on resize would be nicer — destroy+remount is simplest.
    reposition();
  }
  function onScroll() {
    reposition();
  }

  document.addEventListener('mousedown', onDocClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, true);

  header.querySelector('.ip-close')!.addEventListener('click', close);

  donate.addEventListener('click', async () => {
    const amount = amountInput.value.trim();
    const amtNum = parseFloat(amount);
    if (!amtNum || amtNum <= 0) {
      setStatus('Enter a valid amount.', 'error');
      return;
    }
    donate.disabled = true;
    setStatus('Opening extension…', 'info');
    try {
      await chrome.runtime.sendMessage({
        action: 'saveOverlayDonation',
        payload: {
          address: opts.address,
          amount,
          memo: memo.value.trim(),
          label: opts.label ?? truncate(opts.address),
        },
      });
      setStatus('Opened — review and confirm.', 'success');
      // Allow the message to propagate then close.
      setTimeout(close, 350);
    } catch (err) {
      console.error('IndigoPay inline overlay failed:', err);
      setStatus('Could not open extension. Click to retry.', 'error');
      donate.disabled = false;
    }
  });

  return { host, destroy: close, setStatus };
}

export function destroyInlineOverlay(): void {
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();
}

export const __test__ = { truncate, clamp, HOST_ID, PRESETS, CARD_CSS };
