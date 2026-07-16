/**
 * @jest-environment jsdom
 *
 * Tests for the background-service-worker message router. Verifies that
 * the new GF-026 messages are handled:
 *   - saveOverlayDonation → stores pendingOverlayDonation + opens popup
 *   - openDonatePopup     → stores pendingDonationAddress + opens popup
 *   - setProjectContext   → updates tabProjects and toggles context menu
 */

// 56-char Stellar ed25519 public key (1 G + 55 base32 chars).
const VALID_ADDRESS = 'G' + 'A'.repeat(55);

describe('GF-026 background message routing', () => {
  beforeEach(() => {
    // Re-import the module per test so the chrome.runtime.onMessage listener
    // is registered freshly each time.
    jest.resetModules();
    (chrome.action.openPopup as jest.Mock).mockClear();
    (chrome.contextMenus.update as jest.Mock).mockClear();
    (chrome.contextMenus.create as jest.Mock).mockClear();
    (chrome.storage.local.set as jest.Mock).mockClear();
    (chrome.storage.local.get as jest.Mock).mockClear();
    (chrome.storage.sync.get as jest.Mock).mockClear();
    (chrome.storage.local as any).__store = {};
    (chrome.runtime.onMessage.addListener as jest.Mock).mockClear();
    (chrome.runtime.onInstalled.addListener as jest.Mock).mockClear();
    (chrome.tabs.onActivated.addListener as jest.Mock).mockClear();
    (chrome.tabs.onUpdated.addListener as jest.Mock).mockClear();
    (chrome.tabs.onRemoved.addListener as jest.Mock).mockClear();
    (chrome.contextMenus.onClicked.addListener as jest.Mock).mockClear();
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }

  it('registers a runtime message listener at import time', async () => {
    require('../background');
    await flush();
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
  });

  it('saveOverlayDonation → writes pendingOverlayDonation and opens popup', async () => {
    require('../background');
    await flush();
    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const sender = { tab: { id: 7 } } as any;
    const sendResponse = jest.fn();

    listener(
      {
        action: 'saveOverlayDonation',
        payload: {
          address: VALID_ADDRESS,
          amount: '5',
          memo: 'hi',
          label: 'Solar Africa',
        },
      },
      sender,
      sendResponse,
    );
    await flush();

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingOverlayDonation: expect.objectContaining({
          address: VALID_ADDRESS,
          amount: '5',
          label: 'Solar Africa',
        }),
      }),
      expect.any(Function),
    );
    expect(chrome.action.openPopup).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('openDonatePopup → writes pendingDonationAddress and opens popup', async () => {
    require('../background');
    await flush();
    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const sendResponse = jest.fn();
    listener(
      {
        action: 'openDonatePopup',
        address: VALID_ADDRESS,
      },
      undefined,
      sendResponse,
    );
    await flush();

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { pendingDonationAddress: VALID_ADDRESS },
      expect.any(Function),
    );
    expect(chrome.action.openPopup).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('setProjectContext → toggles context menu visibility, off when null', async () => {
    require('../background');
    await flush();
    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    listener({ action: 'setProjectContext', projectId: 'project-abc' }, { tab: { id: 9 } } as any, undefined);
    await flush();

    const updateCalls = (chrome.contextMenus.update as jest.Mock).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    const last = updateCalls[updateCalls.length - 1];
    expect(last[0]).toBe('donate-project');
    expect(last[1]).toEqual({ visible: true });

    // Clear it.
    listener({ action: 'setProjectContext', projectId: null }, { tab: { id: 9 } } as any, undefined);
    await flush();
    const lastCall = (chrome.contextMenus.update as jest.Mock).mock.calls.slice(-1)[0];
    expect(lastCall[1]).toEqual({ visible: false });
  });
});
