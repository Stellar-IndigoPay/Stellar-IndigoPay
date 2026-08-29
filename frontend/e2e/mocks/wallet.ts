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

/**
 * e2e/mocks/wallet.ts — mocked Albedo wallet (popup postMessage protocol).
 *
 * `@albedo-link/intent` connects by `window.open`-ing the Albedo confirm page
 * and exchanging postMessage frames with it (see its `transport-handler.js`):
 *
 *   1. The app opens a popup and waits for a `{ albedo: { protocol: 3 } }`
 *      handshake on its own `window`.
 *   2. Once loaded, the app posts the intent request (with a `__reqid`) to
 *      the popup window.
 *   3. The popup replies to the app's `window` with
 *      `{ albedoIntentResult: { __reqid, …result } }`.
 *
 * The mock below intercepts `window.open` to return a fake popup that (a)
 * sends the handshake and (b) answers each intent request synchronously:
 * `public_key` → the deterministic fixture public key, `tx` → the unsigned
 * envelope echoed back as "signed" (Horizon is mocked separately and never
 * validates the signature).
 */
export async function mockAlbedoWallet(
  page: Page,
  options: MockWalletOptions = {},
) {
  const publicKey = options.publicKey ?? MOCK_PUBLIC_KEY;

  await page.addInitScript(
    ({ publicKey }) => {
      // Synchronous "is Albedo installed" marker used by albedoAdapter.isInstalled().
      (window as unknown as { albedo: unknown }).albedo = true;

      const w = window as unknown as {
        open: typeof window.open;
      };
      const originalOpen = w.open;
      w.open = function open(
        url?: string | URL,
        target?: string,
        features?: string,
      ) {
        // The app's intent transport only ever opens the Albedo confirm
        // dialog during a connection/sign flow — answer it without creating
        // a real popup.
        void url;
        void target;
        void features;

        const fakePopup = {
          postMessage(data: {
            __reqid?: string;
            intent?: string;
            xdr?: string;
          }) {
            // The app posts the intent request TO the popup; respond on the
            // app's own window so the transport's `messageHandler` resolves
            // the pending request.
            const result: Record<string, unknown> = {
              __reqid: data.__reqid,
              intent: data.intent,
            };
            if (data.intent === "public_key") {
              result.pubkey = publicKey;
            } else if (data.intent === "tx") {
              // Echo the unsigned envelope back as "signed" (Horizon is
              // mocked and never checks the signature).
              result.signed_envelope_xdr = data.xdr;
            }
            window.postMessage({ albedoIntentResult: result }, window.location.origin);
          },
          close() {
            /* ephemeral popup — no-op */
          },
        } as unknown as Window;

        // Signal the transport that the popup finished loading. Deferred a
        // tick so the transport's `message` listener is attached first.
        window.setTimeout(() => {
          window.postMessage({ albedo: { protocol: 3 } }, window.location.origin);
        }, 0);

        return fakePopup;
      };
    },
    { publicKey },
  );
}
