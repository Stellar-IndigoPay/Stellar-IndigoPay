// __mocks__/expo-secure-store.js
// In-memory Map-backed mock so jest unit tests can verify secureStore
// wrapper read/write/has/delete roundtrips without needing the real
// Keychain / EncryptedSharedPreferences native module. Each jest worker
// gets its own Map thanks to the `jest.mock()` factory's per-worker
// scope.

const storage = new Map();

const SecureStore = {
  getItemAsync: jest.fn(async (key) => {
    return storage.has(key) ? storage.get(key) : null;
  }),
  setItemAsync: jest.fn(async (key, value) => {
    if (typeof value !== "string") {
      throw new TypeError(
        "expo-secure-store setItemAsync requires a string value",
      );
    }
    storage.set(key, value);
    return undefined;
  }),
  deleteItemAsync: jest.fn(async (key) => {
    storage.delete(key);
    return undefined;
  }),
  // Exposed for test reset; jest's `jest.clearAllMocks()` does not
  // wipe this Map's contents, so each `beforeEach` should call
  // `__resetSecureStoreMock()` to start from a clean slate.
  __resetSecureStoreMock: () => storage.clear(),
  __peekSecureStoreMock: () => storage,
};

module.exports = SecureStore;
