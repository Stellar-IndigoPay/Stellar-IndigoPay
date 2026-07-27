/**
 * Jest setup file — mocks the Chrome extension API.
 */
/* global jest */

var mockChrome = {
  runtime: {
    onMessage: {
      addListener: jest.fn(),
    },
    sendMessage: jest.fn(),
    onInstalled: {
      addListener: jest.fn(),
    },
    lastError: null,
  },
  storage: {
    local: {
      get: jest.fn(function (_keys, callback) {
        var result = {};
        if (callback) callback(result);
      }),
      set: jest.fn(function (_items, callback) {
        if (callback) callback();
      }),
      remove: jest.fn(),
    },
    sync: {
      get: jest.fn(function (_keys, callback) {
        var result = {};
        if (callback) callback(result);
      }),
      set: jest.fn(function (_items, callback) {
        if (callback) callback();
      }),
    },
  },
  action: {
    setBadgeText: jest.fn(),
    setBadgeBackgroundColor: jest.fn(),
    openPopup: jest.fn(function () { return Promise.resolve(); }),
  },
  contextMenus: {
    create: jest.fn(),
    update: jest.fn(function (_id, _properties, callback) {
      if (callback) callback();
    }),
    onClicked: {
      addListener: jest.fn(),
    },
  },
  tabs: {
    onActivated: {
      addListener: jest.fn(),
    },
    onRemoved: {
      addListener: jest.fn(),
    },
    onUpdated: {
      addListener: jest.fn(),
    },
  },
};

globalThis.chrome = mockChrome;
