// __mocks__/NativeModules.js
// Fix compatibility with jest-expo setup script that requires .default and .UIManager on NativeModules
const NativeModules = jest.requireActual('react-native/Libraries/BatchedBridge/NativeModules');

// Expose self as default export to satisfy jest-expo's require('...').default
NativeModules.default = NativeModules;

if (!NativeModules.UIManager) {
  NativeModules.UIManager = {};
}

module.exports = NativeModules;
