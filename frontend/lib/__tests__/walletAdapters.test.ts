/**
 * lib/__tests__/walletAdapters.test.ts
 *
 * Workstream 4 — multi-wallet support.  Unit tests for each adapter's
 * detection, connect, getPublicKey, and signTransaction with a mock XDR,
 * plus the registry (getAvailableWallets / getWalletById /
 * resolveDefaultWallet / persistWalletSelection / clearWalletSelection).
 *
 * Covers the post-main-merge adapters: Freighter, Albedo, xBull and the
 * real WalletConnect v2 adapter (universal-provider + QR modal).
 *
 * @jest-environment jsdom
 */

// ── Freighter: the adapter imports the freighter-api functions directly ──
jest.mock("@stellar/freighter-api", () => {
  let installed = false;
  let publicKey = "";
  let signedXDR = "";
  return {
    __setState: (state: {
      installed?: boolean;
      publicKey?: string;
      signedXDR?: string;
    }) => {
      if (state.installed !== undefined) installed = state.installed;
      if (state.publicKey !== undefined) publicKey = state.publicKey;
      if (state.signedXDR !== undefined) signedXDR = state.signedXDR;
    },
    isConnected: jest.fn(async () => installed),
    requestAccess: jest.fn(async () => publicKey),
    signTransaction: jest.fn(async () => signedXDR),
  };
});

// ── Albedo: the adapter dynamic-imports @albedo-link/intent ──
jest.mock("@albedo-link/intent", () => {
  let publicKey = "";
  let signedXDR = "";
  return {
    __setState: (state: { publicKey?: string; signedXDR?: string }) => {
      if (state.publicKey !== undefined) publicKey = state.publicKey;
      if (state.signedXDR !== undefined) signedXDR = state.signedXDR;
    },
    __esModule: true,
    default: {
      publicKey: jest.fn(async () => ({ pubkey: publicKey })),
      tx: jest.fn(async () => ({ signed_envelope_xdr: signedXDR })),
    },
  };
});

// ── xBull: the adapter instantiates xBullWalletConnect ──
jest.mock("@creit.tech/xbull-wallet-connect", () => {
  let publicKey = "";
  let signedXDR = "";
  return {
    __setState: (state: { publicKey?: string; signedXDR?: string }) => {
      if (state.publicKey !== undefined) publicKey = state.publicKey;
      if (state.signedXDR !== undefined) signedXDR = state.signedXDR;
    },
    xBullWalletConnect: jest.fn().mockImplementation(() => ({
      connect: jest.fn(async () => publicKey),
      sign: jest.fn(async () => signedXDR),
      closeConnections: jest.fn(),
    })),
  };
});

const MOCK_PK = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const MOCK_XDR = "AAAAAGp3L3q0X2hT3hZmVjY1dHlHc2IxU0hKZQ==";
const OPTS = {
  networkPassphrase: "Test SDF Network ; September 2015",
  network: "TESTNET" as const,
};

function setWindowGlobal(key: string, value: unknown) {
  (window as unknown as Record<string, unknown>)[key] = value;
}
function clearWindowGlobals() {
  for (const key of ["albedo", "xBullSDK", "__test_publicKey__"]) {
    delete (window as unknown as Record<string, unknown>)[key];
  }
}

// The WalletConnect adapter keeps module-level provider/session state, so it
// is re-imported fresh (jest.resetModules) in each test that touches it.
function loadWalletConnectAdapter() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("@/lib/wallets/walletConnectAdapter").walletConnectAdapter as {
    id: string;
    isInstalled: () => Promise<boolean>;
    connect: () => Promise<void>;
    getPublicKey: () => Promise<string>;
    signTransaction: (
      xdr: string,
      opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" },
    ) => Promise<string>;
  };
}

describe("Freighter adapter", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const freighterApi = jest.requireMock("@stellar/freighter-api") as {
    __setState: (state: {
      installed?: boolean;
      publicKey?: string;
      signedXDR?: string;
    }) => void;
    requestAccess: jest.Mock;
    signTransaction: jest.Mock;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { freighterAdapter } = jest.requireActual(
    "@/lib/wallets/freighterAdapter",
  );

  beforeEach(() => {
    clearWindowGlobals();
    freighterApi.__setState({ installed: false, publicKey: "", signedXDR: "" });
  });

  it("detects the extension via freighter-api", async () => {
    freighterApi.__setState({ installed: true });
    expect(await freighterAdapter.isInstalled()).toBe(true);

    freighterApi.__setState({ installed: false });
    expect(await freighterAdapter.isInstalled()).toBe(false);
  });

  it("connects (requestAccess) and returns the public key", async () => {
    freighterApi.__setState({ installed: true, publicKey: MOCK_PK });
    await freighterAdapter.connect();
    expect(freighterApi.requestAccess).toHaveBeenCalled();
    expect(await freighterAdapter.getPublicKey()).toBe(MOCK_PK);
  });

  it("signs an XDR", async () => {
    freighterApi.__setState({ signedXDR: `signed-${MOCK_XDR}` });
    expect(await freighterAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(
      `signed-${MOCK_XDR}`,
    );
  });

  it("short-circuits via the test public key hook", async () => {
    setWindowGlobal("__test_publicKey__", MOCK_PK);
    expect(await freighterAdapter.isInstalled()).toBe(true);
    await freighterAdapter.connect();
    expect(await freighterAdapter.getPublicKey()).toBe(MOCK_PK);
    expect(await freighterAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(
      MOCK_XDR,
    );
  });
});

describe("Albedo adapter", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const albedoApi = jest.requireMock("@albedo-link/intent") as {
    __setState: (state: { publicKey?: string; signedXDR?: string }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { albedoAdapter } = jest.requireActual("@/lib/wallets/albedoAdapter");

  beforeEach(() => {
    clearWindowGlobals();
    albedoApi.__setState({ publicKey: MOCK_PK, signedXDR: `albedo-${MOCK_XDR}` });
  });

  it("detects the injected window.albedo global", async () => {
    setWindowGlobal("albedo", {});
    expect(await albedoAdapter.isInstalled()).toBe(true);

    clearWindowGlobals();
    expect(await albedoAdapter.isInstalled()).toBe(false);
  });

  it("connects, returns the public key, and signs via the intent library", async () => {
    setWindowGlobal("albedo", {});
    await albedoAdapter.connect();
    expect(await albedoAdapter.getPublicKey()).toBe(MOCK_PK);
    expect(await albedoAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(
      `albedo-${MOCK_XDR}`,
    );
  });
});

describe("xBull adapter", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const xbullApi = jest.requireMock(
    "@creit.tech/xbull-wallet-connect",
  ) as {
    __setState: (state: { publicKey?: string; signedXDR?: string }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { xbullAdapter } = jest.requireActual("@/lib/wallets/xbullAdapter");

  beforeEach(() => {
    clearWindowGlobals();
    xbullApi.__setState({ publicKey: MOCK_PK, signedXDR: `xbull-${MOCK_XDR}` });
  });

  it("detects xBullSDK", async () => {
    setWindowGlobal("xBullSDK", {});
    expect(await xbullAdapter.isInstalled()).toBe(true);

    clearWindowGlobals();
    expect(await xbullAdapter.isInstalled()).toBe(false);
  });

  it("connects, returns the key, and signs", async () => {
    setWindowGlobal("xBullSDK", {});
    await xbullAdapter.connect();
    expect(await xbullAdapter.getPublicKey()).toBe(MOCK_PK);
    expect(await xbullAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(
      `xbull-${MOCK_XDR}`,
    );
  });
});

describe("WalletConnect adapter (universal-provider)", () => {
  // Reset modules so the adapter's module-level provider/session state is
  // fresh for every test (the adapter caches them at module scope).
  beforeEach(() => {
    jest.resetModules();
  });

  function installMocks(sessionAccounts = [`stellar:pubnet:${MOCK_PK}`]) {
    const provider = {
      on: jest.fn(),
      connect: jest.fn(async () => ({
        namespaces: { stellar: { accounts: sessionAccounts } },
      })),
      request: jest.fn(async () => ({ signedXDR: `wc-${MOCK_XDR}` })),
      session: null,
    };
    jest.mock("@walletconnect/universal-provider", () => ({
      __esModule: true,
      default: { init: jest.fn(async () => provider) },
    }));
    jest.mock("@walletconnect/modal", () => ({
      __esModule: true,
      WalletConnectModal: jest.fn().mockImplementation(() => ({
        openModal: jest.fn(),
        closeModal: jest.fn(),
      })),
    }));
    return provider;
  }

  it("is always listed as an option (web-based pairing)", async () => {
    installMocks();
    const adapter = loadWalletConnectAdapter();
    expect(adapter.id).toBe("walletConnect");
    expect(await adapter.isInstalled()).toBe(true);
  });

  it("pairs via the modal and returns the paired account address", async () => {
    const provider = installMocks();
    const adapter = loadWalletConnectAdapter();

    await adapter.connect();
    expect(provider.connect).toHaveBeenCalledWith(
      expect.objectContaining({ namespaces: { stellar: { methods: ["stellar_signXDR"], chains: ["stellar:pubnet"], events: [] } } }),
    );

    expect(await adapter.getPublicKey()).toBe(MOCK_PK);
  });

  it("signs an XDR through the provider request", async () => {
    const provider = installMocks();
    const adapter = loadWalletConnectAdapter();

    await adapter.connect();
    const signed = await adapter.signTransaction(MOCK_XDR, OPTS);
    expect(signed).toBe(`wc-${MOCK_XDR}`);
    expect(provider.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "stellar_signXDR", params: { xdr: MOCK_XDR } }),
      "stellar:pubnet",
    );
  });

  it("throws a helpful error when signing before connecting", async () => {
    installMocks();
    const adapter = loadWalletConnectAdapter();
    await expect(adapter.signTransaction(MOCK_XDR, OPTS)).rejects.toThrow(
      "Not connected",
    );
  });
});

describe("Wallet registry", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wallets = jest.requireActual("@/lib/wallets") as {
    getAvailableWallets: () => Promise<
      { id: string; isInstalled: () => Promise<boolean> }[]
    >;
    getWalletById: (id: string) => { id: string } | undefined;
    isSupportedWalletId: (id: string) => boolean;
    resolveDefaultWallet: () => Promise<{ id: string } | null>;
    persistWalletSelection: (id: string) => void;
    clearWalletSelection: () => void;
  };

  beforeEach(() => {
    clearWindowGlobals();
    window.localStorage.removeItem("indigopay_wallet_id");
  });

  it("returns only installed wallets in priority order, plus always-available WalletConnect", async () => {
    setWindowGlobal("xBullSDK", {});
    const available = await wallets.getAvailableWallets();
    // xBull installed → xBull first (priority order), WalletConnect is a
    // web-based wallet and is always listed.
    expect(available.map((w) => w.id)).toEqual(["xbull", "walletConnect"]);
  });

  it("lists Albedo + WalletConnect for a fresh browser (no extensions)", async () => {
    const available = await wallets.getAvailableWallets();
    expect(available.map((w) => w.id)).toEqual(["walletConnect"]);
  });

  it("looks up adapters by id and rejects unknown ids", () => {
    expect(wallets.getWalletById("freighter")?.id).toBe("freighter");
    expect(wallets.getWalletById("albedo")?.id).toBe("albedo");
    expect(wallets.getWalletById("xbull")?.id).toBe("xbull");
    expect(wallets.getWalletById("walletConnect")?.id).toBe("walletConnect");
    expect(wallets.getWalletById("rabet")).toBeUndefined();
    expect(wallets.getWalletById("unknown")).toBeUndefined();
    expect(wallets.isSupportedWalletId("freighter")).toBe(true);
    expect(wallets.isSupportedWalletId("unknown")).toBe(false);
  });

  it("resolves the first installed wallet, preferring a stored choice", async () => {
    setWindowGlobal("albedo", {});
    setWindowGlobal("xBullSDK", {});

    // No stored preference → first available in priority order (Albedo).
    expect((await wallets.resolveDefaultWallet())?.id).toBe("albedo");

    // Stored preference wins when that wallet is installed.
    window.localStorage.setItem("indigopay_wallet_id", "xbull");
    expect((await wallets.resolveDefaultWallet())?.id).toBe("xbull");
  });

  it("supports switching wallets mid-session: disconnect clears the stored preference and the next resolve falls back to detection", async () => {
    setWindowGlobal("albedo", {});
    setWindowGlobal("xBullSDK", {});

    // Connect wallet B (xBull) and persist the choice.
    wallets.persistWalletSelection("xbull");
    expect((await wallets.resolveDefaultWallet())?.id).toBe("xbull");

    // Disconnect: clear the preference — the next connect resolves to the
    // first installed wallet in priority order (Albedo).
    wallets.clearWalletSelection();
    expect(window.localStorage.getItem("indigopay_wallet_id")).toBeNull();
    expect((await wallets.resolveDefaultWallet())?.id).toBe("albedo");
  });

  it("ignores a stored preference for a wallet that is no longer installed", async () => {
    setWindowGlobal("albedo", {});

    // Stored preference points at xBull, but xBull is not installed — the
    // resolve must fall back to Albedo rather than returning a dead wallet.
    window.localStorage.setItem("indigopay_wallet_id", "xbull");
    expect((await wallets.resolveDefaultWallet())?.id).toBe("albedo");
  });
});
