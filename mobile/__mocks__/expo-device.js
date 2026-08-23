// __mocks__/expo-device.js
// In-memory mock so jest unit tests can exercise lib/deviceIntegrity.ts
// without the expo-device native module. `isRootedExperimentalAsync` is the
// only method the integrity module consumes; it defaults to a clean device
// and can be flipped per-test:
//   const Device = require("expo-device");
//   Device.isRootedExperimentalAsync.mockResolvedValueOnce(true);

const Device = {
  isDevice: true,
  deviceName: null,
  modelName: null,
  modelId: null,
  osName: null,
  osVersion: null,
  brand: null,
  manufacturer: null,
  deviceType: 0,
  supportedCpuArchitectures: null,
  isRootedExperimentalAsync: jest.fn().mockResolvedValue(false),
};

module.exports = Device;
