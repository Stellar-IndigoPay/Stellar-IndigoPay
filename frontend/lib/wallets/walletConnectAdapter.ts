import type { StellarWalletAdapter } from "./types";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "33df051012ab6ce7e155bc2973f08f1b";

let provider: any = null;
let modal: any = null;
let currentSession: any = null;

/**
 * E2E test hook (mirrors the Freighter adapter's `__test_publicKey__`): when
 * a page sets `window.__walletconnect_test_pubkey__`, connect/getPublicKey/
 * signTransaction short-circuit without importing @walletconnect/universal-
 * provider or opening the QR modal.  This lets the E2E suite exercise the
 * full "pair a mobile wallet → sign → submit → recorded" path deterministically
 * (issue #1096, Workstream 4 — WalletConnect QR pairing E2E, mocked).
 */
function hasTestPublicKey(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as Record<string, unknown>).__walletconnect_test_pubkey__
  );
}

function getTestPublicKey(): string {
  return (window as unknown as Record<string, string>).__walletconnect_test_pubkey__;
}

async function getProvider() {
  if (!provider) {
    const UniversalProvider = (await import("@walletconnect/universal-provider")).default;
    provider = await UniversalProvider.init({
      projectId,
      metadata: {
        name: "IndigoPay",
        description: "Stellar Payments",
        url: typeof window !== "undefined" ? window.location.origin : "https://indigopay.example.com",
        icons: []
      }
    });
  }
  return provider;
}

export const walletConnectAdapter: StellarWalletAdapter = {
  id: "walletConnect",
  name: "WalletConnect",
  description: "WalletConnect",
  installUrl: "https://walletconnect.com/",
  
  async isInstalled(): Promise<boolean> {
    return true;
  },
  
  async connect(): Promise<void> {
    if (hasTestPublicKey()) return;

    const prov = await getProvider();
    
    if (!modal) {
      const { WalletConnectModal } = await import("@walletconnect/modal");
      modal = new WalletConnectModal({ projectId });
    }

    if (!currentSession) {
      prov.on("display_uri", (uri: string) => {
        modal?.openModal({ uri });
      });

      currentSession = await prov.connect({
        namespaces: {
          stellar: {
            methods: ["stellar_signXDR"],
            chains: ["stellar:pubnet"],
            events: []
          }
        }
      });
      
      modal.closeModal();
    }
  },
  
  async getPublicKey(): Promise<string> {
    if (hasTestPublicKey()) return getTestPublicKey();

    const prov = await getProvider();
    if (!currentSession && prov.session) {
        currentSession = prov.session;
    }
    
    if (!currentSession) {
      await walletConnectAdapter.connect();
    }
    
    const accounts = currentSession.namespaces.stellar.accounts;
    const address = accounts[0].split(":")[2];
    return address;
  },
  
  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" }
  ): Promise<string> {
    if (hasTestPublicKey()) return xdr;

    const prov = await getProvider();
    if (!currentSession) {
        throw new Error("Not connected");
    }
    
    const result = await prov.request({
      method: "stellar_signXDR",
      params: { xdr }
    }, "stellar:pubnet");
    
    return (result as any).signedXDR || (result as any).xdr || (result as any);
  }
};
