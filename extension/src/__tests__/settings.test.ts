/**
 * @jest-environment jsdom
 *
 * Tests for the settings module: defaults, persistence, error handling.
 */

import { DEFAULT_SETTINGS, loadSettings, saveSettings, ExtensionSettings } from '../settings';

describe('extension settings', () => {
  beforeEach(() => {
    (chrome.storage.sync.get as jest.Mock).mockClear();
    (chrome.storage.sync.set as jest.Mock).mockClear();
    (chrome.storage.sync.get as jest.Mock).mockImplementation((defaults: any, cb: any) => {
      cb(defaults);
    });
    (chrome.storage.sync.set as jest.Mock).mockImplementation((_items: any, cb: any) => cb && cb());
    // chrome.runtime.lastError is read-only in @types/chrome; cast to any in tests.
    (chrome.runtime as any).lastError = undefined;
  });

  it('exposes the documented default backend URL', () => {
    expect(DEFAULT_SETTINGS.backendUrl).toBe('https://api.stellar-indigopay.app');
  });

  it('loadSettings resolves with the defaults if nothing is stored', async () => {
    const settings = await loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.network).toBe('testnet');
    expect(parseFloat(settings.defaultDonationAmount)).toBeGreaterThan(0);
  });

  it('saveSettings persists to chrome.storage.sync', async () => {
    const next: ExtensionSettings = {
      backendUrl: 'https://staging.api',
      network: 'mainnet',
      defaultDonationAmount: '25',
    };
    await saveSettings(next);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(next, expect.any(Function));
  });

  it('saveSettings rejects when chrome.runtime.lastError is set', async () => {
    (chrome.runtime as any).lastError = { message: 'quota exceeded' };
    (chrome.storage.sync.set as jest.Mock).mockImplementation((_items: any, cb: any) => {
      cb && cb();
    });
    await expect(saveSettings({ ...DEFAULT_SETTINGS })).rejects.toThrow('quota exceeded');
  });
});
