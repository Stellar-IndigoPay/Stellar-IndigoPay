/**
 * lib/__tests__/walletAdapters.test.ts
 *
 * Workstream 4 — multi-wallet support.  Unit tests for each adapter's
 * detection, getPublicKey, and signTransaction with a mock XDR, plus the
 * registry (getAvailableWallets / getWalletById / resolveDefaultWallet).
 *
 * @jest-environment jsdom
 */

// Mock the freighter-api module (the Freighter adapter wraps it directly).
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
    requestAccess: jest.fn(async () => {}),
    getPublicKey: jest.fn(async () => publicKey),
    signTransaction: jest.fn(async () => signedXDR),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const freighterApi = require("@stellar/freighter-api") as {
  __setState: (state: {
    installed?: boolean;
    publicKey?: string;
    signedXDR?: string;
  }) => void;
};

import { freighterAdapter } from "@/lib/wallets/freighter";
import { albedoAdapter } from "@/lib/wallets/albedo";
import { xbullAdapter } from "@/lib/wallets/xbull";
import { rabetAdapter } from "@/lib/wallets/rabet";
import { walletConnectAdapter } from "@/lib/wallets/walletConnect";
import {
  getAvailableWallets,
  getWalletById,
  resolveDefaultWallet,
  isSupportedWalletId,
} from "@/lib/wallets";

const MOCK_PK = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const MOCK_XDR = "AAAAAGp3L3q0X2hT3hZmVjY1dHlHc2IxU0hKZQ==";
const OPTS = { networkPassphrase: "Test SDF Network ; September 2015", network: "TESTNET" as const };

function setWindowGlobal(key: string, value: unknown) {
  (window as unknown as Record<string, unknown>)[key] = value;
}
function clearWindowGlobals() {
  for (const key of [
    "albedo",
    "xBullSDK",
    "rabet",
    "walletConnect",
    "__test_publicKey__",
  ]) {
    delete (window as unknown as Record<string, unknown>)[key];
  }
}

describe("Freighter adapter", () => {
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

  it("returns the public key", async () => {
    freighterApi.__setState({ installed: true, publicKey: MOCK_PK });
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
    expect(await freighterAdapter.getPublicKey()).toBe(MOCK_PK);
    expect(await freighterAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(MOCK_XDR);
  });
});

describe("Albedo adapter (window.albedo)", () => {
  beforeEach(clearWindowGlobals);

  it("detects the injected global", async () => {
    setWindowGlobal("albedo", { publicKey: async () => ({ pubkey: MOCK_PK }) });
    expect(await albedoAdapter.isInstalled()).toBe(true);
    expect(await albedoAdapter.isInstalled()).toBe(true); // second call confirms

    clearWindowGlobals();
    expect(await albedoAdapter.isInstalled()).toBe(false);
  });

  it("returns the public key and signs via albedo.tx", async () => {
    setWindowGlobal("albedo", {
      publicKey: async () => ({ pubkey: MOCK_PK }),
      tx: async () => ({ signed_envelope_xdr: `albedo-${MOCK_XDR}` }),
    });
    expect(await albedoAdapter.getPublicKey()).toBe(MOCK_PK);
    expect(await albedoAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(
      `albedo-${MOCK_XDR}`,
    );
  });

  it("throws a helpful error when not installed", async () => {
    await expect(albedoAdapter.signTransaction(MOCK_XDR, OPTS)).rejects.toThrow(
      "Albedo not installed",
    );
  });
});

describe("xBull adapter (window.xBullSDK)", () => {
  beforeEach(clearWindowGlobals);

  it("detects xBullSDK", async () => {
    setWindowGlobal("xBullSDK", { getPublicKey: async () => MOCK_PK });
    expect(await xbullAdapter.isInstalled()).toBe(true);

    clearWindowGlobals();
    expect(await xbullAdapter.isInstalled()).toBe(false);
  });

  it("connects, returns the key, and signs", async () => {
    const connect = jest.fn(async () => {});
    setWindowGlobal("xBullSDK", {
      connect,
      getPublicKey: async () => MOCK_PK,
      sign: async () => ({ signedXDR: `xbull-${MOCK_XDR}` }),
    });
    expect(await xbullAdapter.getPublicKey()).toBe(MOCK_PK);
    expect(connect).toHaveBeenCalled();
    expect(await xbullAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(
      `xbull-${MOCK_XDR}`,
    );
  });
});

describe("Rabet adapter (window.rabet)", () => {
  beforeEach(clearWindowGlobals);

  it("detects rabet", async () => {
    setWindowGlobal("rabet", { getPublicKey: async () => MOCK_PK });
    expect(await rabetAdapter.isInstalled()).toBe(true);

    clearWindowGlobals();
    expect(await rabetAdapter.isInstalled()).toBe(false);
  });

  it("returns the public key and signs", async () => {
    setWindowGlobal("rabet", {
      getPublicKey: async () => MOCK_PK,
      sign: async () => ({ xdr: `rabet-${MOCK_XDR}` }),
    });
    expect(await rabetAdapter.getPublicKey()).toBe(MOCK_PK);
    expect(await rabetAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(
      `rabet-${MOCK_XDR}`,
    );
  });
});

describe("WalletConnect adapter (window.walletConnect)", () => {
  beforeEach(clearWindowGlobals);

  const stubClient = {
    connect: jest.fn(async () => ({ publicKey: MOCK_PK })),
    getPublicKey: jest.fn(async () => MOCK_PK),
    sign: jest.fn(async () => ({ signedXDR: `wc-${MOCK_XDR}` })),
  };

  it("detects the injected client", async () => {
    setWindowGlobal("walletConnect", stubClient);
    expect(await walletConnectAdapter.isInstalled()).toBe(true);

    clearWindowGlobals();
    expect(await walletConnectAdapter.isInstalled()).toBe(false);
  });

  it("pairs (QR connect), returns the key, and signs", async () => {
    setWindowGlobal("walletConnect", stubClient);
    expect(await walletConnectAdapter.getPublicKey()).toBe(MOCK_PK);
    expect(stubClient.connect).toHaveBeenCalled();
    expect(await walletConnectAdapter.signTransaction(MOCK_XDR, OPTS)).toBe(
      `wc-${MOCK_XDR}`,
    );
    expect(stubClient.sign).toHaveBeenCalledWith({
      xdr: MOCK_XDR,
      networkPassphrase: OPTS.networkPassphrase,
    });
  });

  it("falls back to getPublicKey when connect returns no address", async () => {
    setWindowGlobal("walletConnect", {
      ...stubClient,
      connect: jest.fn(async () => ({})),
    });
    expect(await walletConnectAdapter.getPublicKey()).toBe(MOCK_PK);
  });

  it("throws a helpful error when not installed", async () => {
    await expect(walletConnectAdapter.signTransaction(MOCK_XDR, OPTS)).rejects.toThrow(
      "WalletConnect not installed",
    );
    await expect(walletConnectAdapter.getPublicKey()).rejects.toThrow(
      "WalletConnect not installed",
    );
  });
});

describe("Wallet registry", () => {
  beforeEach(clearWindowGlobals);

  it("returns only installed wallets in priority order", async () => {
    setWindowGlobal("xBullSDK", { getPublicKey: async () => MOCK_PK });
    const available = await getAvailableWallets();
    expect(available.map((w) => w.id)).toEqual(["xbull"]);
  });

  it("looks up adapters by id and rejects unknown ids", () => {
    expect(getWalletById("freighter")?.id).toBe("freighter");
    expect(getWalletById("albedo")?.id).toBe("albedo");
    expect(getWalletById("xbull")?.id).toBe("xbull");
    expect(getWalletById("rabet")?.id).toBe("rabet");
    expect(getWalletById("walletconnect")?.id).toBe("walletconnect");
    expect(getWalletById("unknown")).toBeUndefined();
    expect(isSupportedWalletId("freighter")).toBe(true);
    expect(isSupportedWalletId("unknown")).toBe(false);
  });

  it("resolves the first installed wallet, preferring a stored choice", async () => {
    setWindowGlobal("albedo", { publicKey: async () => ({ pubkey: MOCK_PK }) });
    setWindowGlobal("xBullSDK", { getPublicKey: async () => MOCK_PK });

    // No stored preference → first available in priority order (Albedo).
    const resolved = await resolveDefaultWallet();
    expect(resolved?.id).toBe("albedo");

    // Stored preference wins when that wallet is installed.
    window.localStorage.setItem("indigopay_wallet_id", "xbull");
    const preferred = await resolveDefaultWallet();
    expect(preferred?.id).toBe("xbull");

    window.localStorage.removeItem("indigopay_wallet_id");
  });

  it("returns null when no wallet is installed", async () => {
    expect(await resolveDefaultWallet()).toBeNull();
  });
});
