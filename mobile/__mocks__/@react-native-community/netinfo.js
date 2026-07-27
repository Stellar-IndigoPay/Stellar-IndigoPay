const NetInfo = {
  fetch: jest.fn(() =>
    Promise.resolve({
      isConnected: true,
      isInternetReachable: true,
      type: "wifi",
      details: { isConnectionExpensive: false },
    }),
  ),
  addEventListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
  useNetInfo: jest.fn(() => ({
    isConnected: true,
    isInternetReachable: true,
    type: "wifi",
    details: null,
  })),
  configure: jest.fn(),
};

module.exports = NetInfo;
