/**
 * @jest-environment jsdom
 *
 * Tests for the inline donate overlay module (src/inline-overlay.ts).
 * Verifies:
 *   1. Shadow DOM host injection + cleanup
 *   2. Predicate: rejects invalid / empty Stellar addresses
 *   3. Donate click sends a 'saveOverlayDonation' message via chrome.runtime
 */

import { showInlineOverlay, destroyInlineOverlay, __test__ } from '../inline-overlay';

// 56-char Stellar ed25519 public key (1 G + 55 base32 chars).
const VALID = 'G' + 'A'.repeat(55);

describe('GF-026 inline donate overlay', () => {
  beforeEach(() => {
    (chrome.runtime.sendMessage as jest.Mock).mockClear();
    document.body.innerHTML = '';
    destroyInlineOverlay();
    // Bigger viewport so the card can be positioned.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  });

  it('returns null when given an invalid Stellar address', () => {
    const result = showInlineOverlay({
      address: 'NOT_A_VALID_ADDRESS',
      anchorRect: { left: 0, top: 0, width: 100, height: 20 },
    });
    expect(result).toBeNull();
  });

  it('returns null when given an empty address', () => {
    expect(showInlineOverlay({ address: '', anchorRect: { left: 0, top: 0, width: 0, height: 0 } })).toBeNull();
  });

  it('injects a host element with id indigopay-inline-overlay-host', () => {
    showInlineOverlay({
      address: VALID,
      anchorRect: { left: 100, top: 100, width: 200, height: 30 },
    });
    const host = document.getElementById('indigopay-inline-overlay-host');
    expect(host).not.toBeNull();
    const shadow = host!.shadowRoot;
    expect(shadow).not.toBeNull();
    const card = shadow!.querySelector('.ip-card');
    expect(card).not.toBeNull();
  });

  it('shows truncated address and exposes full address via title', () => {
    const handle = showInlineOverlay({
      address: VALID,
      anchorRect: { left: 50, top: 50, width: 100, height: 20 },
    });
    expect(handle).not.toBeNull();
    const shadow = handle!.host.shadowRoot!;
    const addrEl = shadow.querySelector('.ip-addr') as HTMLElement;
    expect(addrEl.textContent).toBe(__test__.truncate(VALID));
    expect(addrEl.getAttribute('title')).toBe(VALID);
  });

  it('renders three preset buttons (1, 5, 10 XLM)', () => {
    const handle = showInlineOverlay({
      address: VALID,
      anchorRect: { left: 0, top: 0, width: 100, height: 20 },
    });
    const presets = handle!.host.shadowRoot!.querySelectorAll('.ip-preset');
    expect(presets.length).toBe(3);
    const labels = Array.from(presets).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['1 XLM', '5 XLM', '10 XLM']);
  });

  it('preselects amount when opts.amount is provided', () => {
    const handle = showInlineOverlay({
      address: VALID,
      anchorRect: { left: 0, top: 0, width: 100, height: 20 },
      amount: '10',
    });
    const amountInput = handle!.host.shadowRoot!.querySelector('.ip-input') as HTMLInputElement;
    expect(amountInput.value).toBe('10');
    const active = handle!.host.shadowRoot!.querySelector('.ip-preset.active');
    expect(active?.textContent?.trim()).toBe('10 XLM');
  });

  it('donate button is disabled when amount is empty', () => {
    const handle = showInlineOverlay({
      address: VALID,
      anchorRect: { left: 0, top: 0, width: 100, height: 20 },
    });
    const donate = handle!.host.shadowRoot!.querySelector('.ip-donate') as HTMLButtonElement;
    expect(donate.disabled).toBe(true);
  });

  it('clicking Donate sends a saveOverlayDonation chrome message', async () => {
    const handle = showInlineOverlay({
      address: VALID,
      anchorRect: { left: 0, top: 0, width: 100, height: 20 },
      memo: 'thanks',
    })!;
    const shadow = handle.host.shadowRoot!;
    const amountInput = shadow.querySelector('.ip-input') as HTMLInputElement;
    amountInput.value = '7';
    amountInput.dispatchEvent(new Event('input'));
    const donate = shadow.querySelector('.ip-donate') as HTMLButtonElement;
    expect(donate.disabled).toBe(false);
    donate.click();
    // Allow microtasks (await chrome.runtime.sendMessage) to flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const msg = (chrome.runtime.sendMessage as jest.Mock).mock.calls[0][0];
    expect(msg.action).toBe('saveOverlayDonation');
    expect(msg.payload.address).toBe(VALID);
    expect(msg.payload.amount).toBe('7');
    expect(msg.payload.memo).toBe('thanks');
  });

  it('destroy() removes the host element from the DOM', () => {
    const handle = showInlineOverlay({
      address: VALID,
      anchorRect: { left: 0, top: 0, width: 100, height: 20 },
    });
    expect(document.getElementById('indigopay-inline-overlay-host')).not.toBeNull();
    handle!.destroy();
    expect(document.getElementById('indigopay-inline-overlay-host')).toBeNull();
  });

  it('truncate() test helper hides middle of long strings', () => {
    // VALID = 'G' + 'A'.repeat(55) → 'GAAA…AAAA' for head=4, tail=4
    expect(__test__.truncate(VALID, 4, 4)).toBe('GAAA…AAAA');
    expect(__test__.truncate(VALID, 6, 6)).toBe('GAAAAA…AAAAAA');
    expect(__test__.truncate('SHORT', 4, 4)).toBe('SHORT');
  });

  it('clamp() test helper honours min and max', () => {
    expect(__test__.clamp(5, 0, 10)).toBe(5);
    expect(__test__.clamp(-1, 0, 10)).toBe(0);
    expect(__test__.clamp(11, 0, 10)).toBe(10);
  });
});
