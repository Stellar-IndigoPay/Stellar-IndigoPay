// Lightweight stubs for the chrome.* APIs that our modules reference.
// Each is a Jest mock so tests can assert calls if needed.
const makeMockStorage = () => {
  const store: Record<string, any> = {};
  return {
    get: jest.fn((keys: any, cb?: (items: any) => void) => {
      const wanted = Array.isArray(keys) ? keys : typeof keys === 'object' ? keys : [keys];
      const out: Record<string, any> = {};
      if (wanted && typeof wanted === 'object' && !Array.isArray(wanted)) {
        Object.entries(wanted).forEach(([k, v]) => (out[k] = (store[k] ?? v)));
      } else {
        (wanted as string[]).forEach((k) => (out[k] = store[k]));
      }
      if (cb) cb(out);
      return Promise.resolve(out);
    }),
    set: jest.fn((items: any, cb?: () => void) => {
      Object.assign(store, items);
      if (cb) cb();
      return Promise.resolve();
    }),
    remove: jest.fn((keys: any, cb?: () => void) => {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((k) => delete store[k]);
      if (cb) cb();
      return Promise.resolve();
    }),
    __store: store,
  };
};

const runtime = {
  sendMessage: jest.fn().mockResolvedValue(undefined),
  onMessage: { addListener: jest.fn() },
  onInstalled: { addListener: jest.fn() },
  // Tests assign to lastError to simulate quota / auth errors; declare as
  // a mutable property on this object so the assignment typechecks.
  lastError: undefined as { message?: string } | undefined,
};

const tabs = {
  onActivated: { addListener: jest.fn() },
  onUpdated: { addListener: jest.fn() },
  onRemoved: { addListener: jest.fn() },
};

const contextMenus = {
  create: jest.fn((_opts: any, cb?: () => void) => cb && cb()),
  update: jest.fn((_id: string, _opts: any, cb?: () => void) => cb && cb()),
  onClicked: { addListener: jest.fn() },
};

const action = {
  setBadgeText: jest.fn().mockResolvedValue(undefined),
  setBadgeBackgroundColor: jest.fn().mockResolvedValue(undefined),
  openPopup: jest.fn().mockResolvedValue(undefined),
};

(globalThis as any).chrome = {
  runtime,
  tabs,
  contextMenus,
  action,
  storage: { local: makeMockStorage(), sync: makeMockStorage() },
  permissions: { request: jest.fn().mockResolvedValue(true) },
};

// jsdom doesn't ship a complete NodeFilter; supply a minimal one for our tests.
if (typeof (globalThis as any).NodeFilter === 'undefined') {
  (globalThis as any).NodeFilter = {
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
    SHOW_TEXT: 0x4,
    SHOW_ELEMENT: 0x1,
  };
}
