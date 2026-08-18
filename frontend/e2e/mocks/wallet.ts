/**
 * e2e/mocks/wallet.ts — mocked Freighter wallet extension.
 *
 * `@stellar/freighter-api` does NOT expose a simple `window.freighter`
 * method-bag; it talks to the real extension's content script via
 * `window.postMessage` using a `FREIGHTER_EXTERNAL_MSG_REQUEST` /
 * `FREIGHTER_EXTERNAL_MSG_RESPONSE` envelope (see
 * node_modules/@stellar/freighter-api/build/index.min.js). `isConnected()`
 * additionally short-circuits on a truthy `window.freighter` marker without
 * a round trip, which we set for a fast, reliable "is installed" check.
 * Every other call (getPublicKey, requestAccess, signTransaction, ...) goes
 * through the postMessage protocol, so the mock has to speak that protocol
 * rather than just stubbing a global object.
 */
import type { Page } from "@playwright/test";

// Deterministic keypair (Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7))) —
// a real, checksum-valid Stellar address. stellar-sdk validates the
// StrKey checksum when building transactions, so an arbitrary "GAAA...TEST"
// string (as sometimes seen in illustrative examples) throws immediately.
export const MOCK_PUBLIC_KEY =
  "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

export interface MockWalletOptions {
  publicKey?: string;
  network?: "TESTNET" | "PUBLIC";
}

export async function mockFreighterWallet(
  page: Page,
  options: MockWalletOptions = {},
) {
  const publicKey = options.publicKey ?? MOCK_PUBLIC_KEY;
  const network = options.network ?? "TESTNET";

  await page.addInitScript(
    ({ publicKey, network }) => {
      // Synchronous "is Freighter installed" marker used by isConnected().
      (window as unknown as { freighter: unknown }).freighter = true;

      window.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as
          | { source?: string; type?: string; messageId?: number; transactionXdr?: string }
          | undefined;
        if (!data || data.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;

        const respond = (payload: Record<string, unknown>) => {
          window.postMessage(
            {
              source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
              messageId: data.messageId,
              messagedId: data.messageId,
              ...payload,
            },
            window.location.origin,
          );
        };

        switch (data.type) {
          case "REQUEST_CONNECTION_STATUS":
            respond({ isConnected: true });
            break;
          case "REQUEST_ALLOWED_STATUS":
            respond({ isAllowed: true });
            break;
          case "REQUEST_ACCESS":
          case "REQUEST_PUBLIC_KEY":
            respond({ publicKey });
            break;
          case "REQUEST_NETWORK":
            respond({ network });
            break;
          case "SUBMIT_TRANSACTION":
            // Echo the unsigned envelope back as "signed". Horizon
            // submission is mocked separately (see e2e/mocks/horizon.ts)
            // and never checks the signature.
            respond({ signedTransaction: data.transactionXdr });
            break;
          default:
            break;
        }
      });
    },
    { publicKey, network },
  );
}
