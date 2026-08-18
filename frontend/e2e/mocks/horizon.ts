/**
 * e2e/mocks/horizon.ts — mocked Stellar Horizon network.
 *
 * The default (no CONTRACT_ID) donation path in `lib/stellar.ts` talks to
 * Horizon directly via `@stellar/stellar-sdk`'s `Horizon.Server`: it loads
 * the donor's account to read a sequence number (`loadAccount`), and posts
 * the signed envelope to `/transactions` (`submitTransaction`). Horizon's
 * `submitTransaction` also calls `loadAccount` on the destination first, to
 * check a "memo required" flag — a 404 there is caught internally and
 * treated as "no memo required", so unknown destinations can safely 404.
 *
 * `stellar-sdk`'s response parsing only requires `result_xdr` to be absent
 * to skip building an `AccountResponse`/result breakdown, so the fixtures
 * below stay intentionally minimal — just enough for the SDK not to throw.
 */
import type { Page } from "@playwright/test";

export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const MOCK_TX_HASH =
  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

function accountFixture(accountId: string) {
  return {
    id: accountId,
    account_id: accountId,
    sequence: "123456789000000",
    subentry_count: 0,
    last_modified_ledger: 1,
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    balances: [
      {
        balance: "10000.0000000",
        buying_liabilities: "0.0000000",
        selling_liabilities: "0.0000000",
        asset_type: "native",
      },
    ],
    signers: [{ key: accountId, weight: 1, type: "ed25519_public_key" }],
    data: {},
    data_attr: {},
    num_sponsoring: 0,
    num_sponsored: 0,
    paging_token: accountId,
  };
}

export async function mockHorizonAPI(page: Page) {
  await page.route(`${HORIZON_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    // GET /accounts/{id}
    const accountMatch = path.match(/^\/accounts\/([^/]+)$/);
    if (accountMatch && request.method() === "GET") {
      return json(accountFixture(accountMatch[1]));
    }

    // POST /transactions — omit result_xdr so the SDK returns the raw JSON
    // without attempting to decode a (fake) result envelope.
    if (path === "/transactions" && request.method() === "POST") {
      return json({
        hash: MOCK_TX_HASH,
        ledger: 100,
        successful: true,
        envelope_xdr: "",
      });
    }

    // Everything else (payment streams, fee stats, effects, ...): return an
    // empty Horizon collection page so callers relying on `_embedded.records`
    // resolve immediately instead of timing out against the real network.
    return json({ _embedded: { records: [] }, _links: {} });
  });
}
