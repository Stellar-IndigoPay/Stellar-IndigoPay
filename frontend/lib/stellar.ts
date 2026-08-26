/**
 * lib/stellar.ts — Stellar SDK helpers for IndigoPay
 *
 * Utilities for interacting with the Stellar network (Horizon) and Soroban (RPC)
 * from the frontend.
 *
 * @see https://developers.stellar.org/docs/data/horizon
 * @see https://soroban.stellar.org/docs
 */
import {
  Horizon,
  Networks,
  Asset,
  Operation,
  TransactionBuilder,
  Transaction,
  Memo,
  rpc,
  Contract,
  scValToNative,
  Address,
  nativeToScVal,
  Account,
  xdr,
} from "@stellar/stellar-sdk";
import { formatNumber, PINNED_LOCALE } from "@/utils/format";

export const NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ||
  "testnet") as "testnet" | "mainnet";
const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";
const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
export const server = new Horizon.Server(HORIZON_URL);
export const rpcServer = new rpc.Server(RPC_URL);
export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID || "";

/** Soroban escrow contract (deploy `contracts/escrow-contract`). */
export const ESCROW_CONTRACT_ID =
  process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID || "";

/**
 * Fetch an account's native XLM balance using Horizon.
 *
 * @param publicKey - Stellar account public key.
 * @returns XLM balance as a string (decimal).
 * @throws If the account does not exist, is not funded, or Horizon is unreachable.
 *
 * @see https://developers.stellar.org/docs/data/horizon/api-reference/resources/accounts
 */
export async function getXLMBalance(publicKey: string): Promise<string> {
  try {
    const account = await server.loadAccount(publicKey);
    const xlm = account.balances.find((b) => b.asset_type === "native");
    return xlm ? xlm.balance : "0";
  } catch {
    throw new Error("Account not found or not funded.");
  }
}

/**
 * Funds a testnet account via Stellar Friendbot.
 * Returns the credited XLM balance after funding.
 * Only works on testnet — throws on mainnet.
 *
 * @param publicKey - Stellar account public key to fund.
 * @returns The account's XLM balance after funding.
 * @throws If called on mainnet, the request fails, or the account is already funded.
 *
 * @see https://friendbot.stellar.org
 */
export async function getFriendBotFunding(publicKey: string): Promise<string> {
  if (NETWORK === "mainnet") {
    throw new Error("Friendbot is only available on testnet.");
  }
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // A 400 with "createAccountAlreadyExist" means it was already funded
    if (response.status === 400 && body.includes("createAccountAlreadyExist")) {
      throw new Error("Account is already funded.");
    }
    throw new Error(`Friendbot request failed (${response.status}).`);
  }
  // Wait briefly for Horizon to process the account creation
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return getXLMBalance(publicKey);
}

// ── Dynamic base-reserve & account summary (issue #1096, Workstream 1) ───────

// The Stellar base reserve is a network parameter that can change via
// governance, and accounts with subentries (trustlines, signers, offers) owe
// more reserve than a bare account.  The Max button therefore queries the
// live value instead of assuming a fixed 2 XLM.
let cachedBaseReserve: number | null = null;
let cachedBaseReserveAt = 0;
const BASE_RESERVE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Test-only: drop the cached base reserve so the next call re-queries
 * Horizon.  Harmless in production (it only forces one extra ledger fetch).
 */
export function resetBaseReserveCache(): void {
  cachedBaseReserve = null;
  cachedBaseReserveAt = 0;
}

/**
 * Fetch the current Stellar base reserve (in XLM) from Horizon's latest
 * ledger, cached for an hour.  Falls back to the 2 XLM default when the
 * network is unreachable — the Max button degrades gracefully instead of
 * disappearing.
 *
 * @returns Base reserve in XLM (e.g. 0.5, 2).
 * @throws Never.
 */
export async function getBaseReserveXLM(): Promise<number> {
  const now = Date.now();
  if (
    cachedBaseReserve !== null &&
    now - cachedBaseReserveAt < BASE_RESERVE_CACHE_TTL_MS
  ) {
    return cachedBaseReserve;
  }
  try {
    const page = await server.ledgers().order("desc").limit(1).call();
    const raw = page.records?.[0]?.base_reserve_in_stroops;
    const stroops = raw != null ? parseInt(String(raw), 10) : NaN;
    if (Number.isFinite(stroops) && stroops > 0) {
      cachedBaseReserve = stroops / STROOPS_PER_XLM;
      cachedBaseReserveAt = now;
      return cachedBaseReserve;
    }
  } catch {
    // Fall through to the default.
  }
  // The protocol-level base reserve is 0.5 XLM.  This is distinct from the
  // 2 XLM MINIMUM_BALANCE_XLM default used by calculateMaxDonation, which
  // is a conservative estimate of the full account minimum (2 + subentries)
  // reserve when the account's subentry count is unknown.
  return BASE_RESERVE_FALLBACK_XLM;
}

/**
 * Load a donor account once and return the XLM balance plus the account
 * fields needed to compute its true minimum reserve — subentries and
 * sponsored-entry counts.  An account owes base reserve for its 2 base
 * entries, each subentry (trustline/signer/offer), and each entry it
 * sponsors for another account, so the fixed 2 XLM shortcut understates
 * the reserve for accounts that hold trustlines or sponsor entries.
 *
 * @param publicKey - Stellar account public key.
 * @returns Balance (XLM decimal string), subentry count, and the
 *   Horizon sponsorship counts (entries this account sponsors / entries
 *   sponsored for it by others).
 * @throws When the account does not exist or Horizon is unreachable.
 */
export async function getAccountSummary(publicKey: string): Promise<{
  balance: string;
  subentries: number;
  numSponsoring: number;
  numSponsored: number;
}> {
  try {
    const account = await server.loadAccount(publicKey);
    const xlm = account.balances.find((b) => b.asset_type === "native");
    const accountFields = account as AccountResponseWithSubentries;
    return {
      balance: xlm ? xlm.balance : "0",
      subentries: accountFields.num_subentries ?? 0,
      numSponsoring: accountFields.num_sponsoring ?? 0,
      numSponsored: accountFields.num_sponsored ?? 0,
    };
  } catch {
    throw new Error("Account not found or not funded.");
  }
}

interface AccountResponseWithSubentries {
  num_subentries?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

/**
 * Compute an account's true minimum reserve (XLM) from its Horizon-derived
 * fields: base_reserve × (2 + subentries + sponsoring).
 *
 * The Stellar protocol charges base reserve for the account's own 2 base
 * entries, every subentry it holds, and every entry it sponsors for other
 * accounts (entries sponsored FOR it are still its subentries and are
 * already counted).  `baseReserveXLM` is the live network base reserve
 * (0.5 XLM on current protocol) from getBaseReserveXLM().
 *
 * @param subentries - num_subentries from Horizon.
 * @param numSponsoring - num_sponsoring from Horizon.
 * @param baseReserveXLM - Live base reserve in XLM (0.5 on protocol 14+).
 * @returns The account's minimum balance in XLM.
 */
export function calculateMinimumReserveXLM(
  subentries: number,
  numSponsoring: number,
  baseReserveXLM: number,
): number {
  return baseReserveXLM * (2 + subentries + numSponsoring);
}

/**
 * Fetch a non-native asset balance (e.g., USDC) for an account.
 *
 * @param publicKey - Stellar account public key.
 * @param assetCode - Asset code (e.g., "USDC").
 * @param assetIssuer - Issuer account public key.
 * @returns Balance string, or `null` when the trustline is missing.
 * @throws If the account does not exist, is not funded, or Horizon is unreachable.
 */
export async function getAssetBalance(
  publicKey: string,
  assetCode: string,
  assetIssuer: string,
): Promise<string | null> {
  try {
    const account = await server.loadAccount(publicKey);
    const asset = account.balances.find(
      (b: any) => b.asset_code === assetCode && b.asset_issuer === assetIssuer,
    );
    // If the asset is not present on the account, the user likely doesn't have the trustline.
    if (!asset) return null;
    return asset.balance;
  } catch {
    throw new Error("Account not found or not funded.");
  }
}

/**
 * Build an unsigned payment transaction for a donation (native XLM or a custom asset).
 *
 * @param params - Transaction builder parameters.
 * @param params.fromPublicKey - Source account public key (donor).
 * @param params.toPublicKey - Destination account public key (project).
 * @param params.amount - Amount as a decimal string.
 * @param params.memo - Optional text memo (trimmed to 28 chars).
 * @param params.asset - Optional asset. Omit to send native XLM.
 * @returns Unsigned Stellar transaction ready to be signed by the wallet.
 * @throws If Horizon fails to load the source account or parameters are invalid.
 *
 * @example
 * const tx = await buildDonationTransaction({
 *   fromPublicKey: "G...DONOR...",
 *   toPublicKey: "G...PROJECT...",
 *   amount: "5",
 *   memo: "IndigoPay donation",
 * });
 * // Sign and submit with your wallet provider.
 *
 * @see https://developers.stellar.org/docs/data/horizon/api-reference/resources/accounts
 */
export async function buildDonationTransaction({
  fromPublicKey,
  toPublicKey,
  amount,
  memo,
  asset,
}: {
  fromPublicKey: string;
  toPublicKey: string;
  amount: string;
  memo?: string;
  asset?: { code: string; issuer?: string };
}) {
  const source = await server.loadAccount(fromPublicKey);
  const paymentAsset =
    asset && asset.code && asset.issuer
      ? new Asset(asset.code, asset.issuer)
      : Asset.native();

  const builder = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: toPublicKey,
        asset: paymentAsset,
        amount,
      }),
    )
    .setTimeout(60);
  if (memo) builder.addMemo(Memo.text(memo.slice(0, 28)));
  return builder.build();
}

// ── Transaction preview / simulation (issue #1096, Workstream 5) ─────────────

export interface SimulationResult {
  /** Destination (project wallet) public key. */
  destination: string;
  /** Donation amount in the donor's currency, decimal string. */
  amount: string;
  /** "XLM" | "USDC" — the currency being donated. */
  currency: "XLM" | "USDC";
  /** Estimated network fee in stroops. */
  feeStroops: number;
  /** Estimated network fee as an XLM decimal string. */
  feeXLM: string;
  /** Total debited from the wallet (amount + fee) for XLM donations. */
  totalDebited: string | null;
  /** Source account sequence number the tx will consume. */
  sequence: string;
}

/**
 * Simulate a donation before prompting the wallet to sign it (no blind
 * signing).  Builds the exact skeleton transaction the donor would sign
 * and derives the human-readable summary from it — destination, amount,
 * estimated fee, and total debited — so the donor reviews the real
 * parameters, not a hand-typed approximation.
 *
 * Classic Stellar payments are deterministic (fee = base fee × operations,
 * amount = the payment amount), so no Soroban RPC round-trip is required;
 * the estimation is exact for the fee class the tx will use.
 *
 * @param params - Simulation parameters (mirrors buildDonationTransaction).
 * @returns A SimulationResult safe to render in TransactionPreview.
 * @throws When the source account cannot be loaded or params are invalid.
 */
export async function simulateDonation({
  fromPublicKey,
  toPublicKey,
  amount,
  currency,
  memo,
  asset,
}: {
  fromPublicKey: string;
  toPublicKey: string;
  amount: string;
  currency: "XLM" | "USDC";
  memo?: string;
  asset?: { code: string; issuer?: string };
}): Promise<SimulationResult> {
  const tx = await buildDonationTransaction({
    fromPublicKey,
    toPublicKey,
    amount,
    memo,
    asset,
  });

  const feeStroops = estimateFeeStroops(tx.operations.length);
  const feeXLM = stroopsToXLM(feeStroops);

  return {
    destination: toPublicKey,
    amount,
    currency,
    feeStroops,
    feeXLM,
    totalDebited:
      currency === "XLM"
        ? (parseFloat(amount) + feeStroops / STROOPS_PER_XLM).toFixed(7)
        : null,
    sequence: tx.sequence,
  };
}

/**
 * Shorten a Stellar public key for display: "GABC…XYZ".
 *
 * @param address - Full public key (G…).
 * @param head - Characters to keep at the start (default 4).
 * @param tail - Characters to keep at the end (default 3).
 * @returns Truncated address, or the input when shorter than head+tail+1.
 */
export function shortenAddressForPreview(
  address: string,
  head = 4,
  tail = 3,
): string {
  if (!address) return "";
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/**
 * Builds a Soroban contract donation transaction.
 * Invokes the contract's donate() function which transfers XLM and records the donation on-chain.
 *
 * @param params - Contract call parameters.
 * @param params.contractId - Target Soroban contract id.
 * @param params.tokenAddress - Token contract address (for token-based donations).
 * @param params.donor - Donor Stellar public key.
 * @param params.projectId - Project id (string) recorded by the contract.
 * @param params.amount - Amount as a decimal string in XLM units.
 * @param params.msgHash - Message hash (u32) recorded by the contract.
 * @returns Unsigned assembled transaction ready to be signed by the wallet.
 * @throws If simulation fails, the account is unfunded, or the contract rejects the call.
 *
 * @see https://soroban.stellar.org/docs
 */
export async function buildContractDonationTransaction({
  contractId,
  tokenAddress,
  donor,
  projectId,
  amount,
  msgHash,
}: {
  contractId: string;
  tokenAddress: string;
  donor: string;
  projectId: string;
  amount: string;
  msgHash: number;
}) {
  const source = await server.loadAccount(donor);
  const contract = new Contract(contractId);

  // Convert parameters to Soroban types
  const donorAddress = new Address(donor);
  const tokenAddr = new Address(tokenAddress);
  const amountInStroops = Math.floor(parseFloat(amount) * 10_000_000);

  // Build the contract invocation transaction
  const builder = new TransactionBuilder(source, {
    fee: "1000000", // Higher fee for contract calls
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "donate",
        tokenAddr.toScVal(),
        donorAddress.toScVal(),
        nativeToScVal(projectId, { type: "string" }),
        nativeToScVal(amountInStroops, { type: "i128" }),
        nativeToScVal(msgHash, { type: "u32" }),
      ),
    )
    .setTimeout(60);

  const tx = builder.build();

  // Simulate to get the resource fees
  const simulated = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationSuccess(simulated)) {
    // Prepare the transaction with simulation results
    return rpc.assembleTransaction(tx, simulated).build();
  } else {
    throw formatSimulationFailure(simulated);
  }
}

/**
 * Builds a Soroban transaction that calls `create_recurring(donor, project_id, amount, currency, interval_ledgers, keeper_incentive, msg_hash)`
 * on the IndigoPay contract.
 */
export async function buildCreateRecurringTransaction({
  contractId,
  donor,
  projectId,
  amount,
  currency,
  intervalLedgers,
  keeperIncentive,
  msgHash,
}: {
  contractId: string;
  donor: string;
  projectId: string;
  amount: string;
  currency: string;
  intervalLedgers: number;
  keeperIncentive: string;
  msgHash: number;
}) {
  const source = await server.loadAccount(donor);
  const contract = new Contract(contractId);

  const donorAddress = new Address(donor);
  const amountInStroops = Math.floor(parseFloat(amount) * 10_000_000);
  const keeperIncentiveInStroops = Math.floor(parseFloat(keeperIncentive) * 10_000_000);

  const builder = new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "create_recurring",
        donorAddress.toScVal(),
        nativeToScVal(projectId, { type: "string" }),
        nativeToScVal(amountInStroops, { type: "i128" }),
        nativeToScVal(currency, { type: "symbol" }),
        nativeToScVal(intervalLedgers, { type: "u32" }),
        nativeToScVal(keeperIncentiveInStroops, { type: "i128" }),
        nativeToScVal(msgHash, { type: "u32" }),
      )
    )
    .setTimeout(60);

  const tx = builder.build();
  const simulated = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationSuccess(simulated)) {
    return rpc.assembleTransaction(tx, simulated).build();
  } else {
    throw formatSimulationFailure(simulated);
  }
}

/**
 * Builds a Soroban transaction that calls `cancel_recurring(donor, recurring_id)`
 * on the IndigoPay contract.
 */
export async function buildCancelRecurringTransaction({
  contractId,
  donor,
  recurringId,
}: {
  contractId: string;
  donor: string;
  recurringId: number;
}) {
  const source = await server.loadAccount(donor);
  const contract = new Contract(contractId);
  const donorAddress = new Address(donor);

  const builder = new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "cancel_recurring",
        donorAddress.toScVal(),
        nativeToScVal(recurringId, { type: "u32" }),
      )
    )
    .setTimeout(60);

  const tx = builder.build();
  const simulated = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationSuccess(simulated)) {
    return rpc.assembleTransaction(tx, simulated).build();
  } else {
    throw formatSimulationFailure(simulated);
  }
}


/**
 * Maps the frontend `BadgeTier` strings (lowercase, used across the UI and the
 * off-chain API) to the on-chain `BadgeTier` enum variant names used by the
 * IndigoPay Soroban contract (`Seedling | Tree | Forest | EarthGuardian`).
 */
export const CONTRACT_BADGE_SYMBOL: Record<string, string> = {
  seedling: "Seedling",
  tree: "Tree",
  forest: "Forest",
  earth: "EarthGuardian",
};

/**
 * Builds the Soroban ScVal for a `BadgeTier` unit-variant enum value.
 * Soroban serialises a unit (data-less) enum variant as a Vec containing a
 * single Symbol with the variant's name.
 */
function badgeTierToScVal(tier: string) {
  const variant = CONTRACT_BADGE_SYMBOL[tier];
  if (!variant) {
    throw new Error(`Unknown badge tier "${tier}". Cannot mint Impact NFT.`);
  }
  return xdr.ScVal.scvVec([nativeToScVal(variant, { type: "symbol" })]);
}

/**
 * Builds a Soroban transaction that calls `mint_impact_nft(donor, tier)` on the
 * IndigoPay contract. The `donor` account authorises and pays for the mint, and
 * `tier` must match the donor's current on-chain badge tier (enforced by the
 * contract). Pass the lowercase frontend tier string (e.g. "seedling").
 */
export async function buildMintImpactNftTransaction({
  contractId,
  donor,
  tier,
}: {
  contractId: string;
  donor: string;
  tier: string;
}) {
  if (!contractId.trim()) {
    throw new Error(
      "IndigoPay contract is not configured (set NEXT_PUBLIC_CONTRACT_ID).",
    );
  }
  const source = await server.loadAccount(donor);
  const contract = new Contract(contractId);
  const donorAddr = new Address(donor);

  const tx = new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "mint_impact_nft",
        donorAddr.toScVal(),
        badgeTierToScVal(tier),
      ),
    )
    .setTimeout(60)
    .build();

  const simulated = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(simulated)) {
    return rpc.assembleTransaction(tx, simulated).build();
  }
  throw formatMintSimulationFailure(simulated);
}

/** Maps Soroban `mint_impact_nft` simulation errors to user-facing messages. */
export function formatMintSimulationFailure(simulated: unknown): Error {
  const raw = JSON.stringify(simulated);
  if (raw.includes("NFT already minted for this tier")) {
    return new Error("You have already claimed the Impact NFT for this tier.");
  }
  if (raw.includes("No badge tier reached yet")) {
    return new Error(
      "No badge tier reached yet — donate more to unlock an Impact NFT.",
    );
  }
  if (raw.includes("Tier does not match donor's current badge")) {
    return new Error(
      "This tier no longer matches your on-chain badge. Refresh and try again.",
    );
  }
  if (raw.includes("Cannot mint NFT for None tier")) {
    return new Error("There is no badge tier to claim yet.");
  }
  if (/underfunded|insufficient/i.test(raw) && /balance|fee|Fund/i.test(raw)) {
    return new Error(
      "Insufficient XLM to pay Soroban fees. Add test XLM to this account and try again.",
    );
  }
  if (raw.includes("HostError") || raw.includes("VmValidation")) {
    return new Error(
      "The contract rejected this mint. Check the network (testnet/mainnet) and contract ID.",
    );
  }
  return new Error(
    "Could not simulate mint_impact_nft. Verify NEXT_PUBLIC_CONTRACT_ID and that your badge tier is recorded on-chain.",
  );
}

/**
 * Submits a signed Soroban contract transaction via the Soroban RPC server and
 * polls until it is applied. Returns the transaction hash and the ledger it was
 * included in (the "mint ledger" for an NFT mint). Unlike {@link submitTransaction}
 * (which targets Horizon and is unsuitable for contract invocations), this uses
 * the RPC `sendTransaction` / `getTransaction` flow.
 */
export async function submitSorobanTransaction(
  signedXDR: string,
  {
    timeoutMs = 30000,
    intervalMs = 1500,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ hash: string; ledger: number }> {
  const tx = new Transaction(signedXDR, NETWORK_PASSPHRASE);
  const sent = await rpcServer.sendTransaction(tx);

  if (sent.status === "ERROR") {
    throw new Error(
      `Transaction submission failed: ${JSON.stringify(sent.errorResult ?? sent)}`,
    );
  }

  const hash = sent.hash;
  const deadline = Date.now() + timeoutMs;

  // Poll the RPC until the transaction is applied (SUCCESS) or fails.
  while (Date.now() < deadline) {
    const result = await rpcServer.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash, ledger: result.ledger };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(
        "Transaction failed on-chain. The mint was not completed.",
      );
    }
    // NOT_FOUND — still pending; wait and retry.
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    "Timed out waiting for the mint transaction to confirm. Check the explorer with the transaction hash.",
  );
}

/**
 * Builds a Soroban transaction that calls `release_escrow(client, job_id)` on the escrow contract.
 * The client account must match the job’s client and must have funded this job via `create_job` on-chain.
 *
 * @param params - Escrow release parameters.
 * @param params.contractId - Escrow contract id.
 * @param params.jobId - Job id used when the job was created on-chain.
 * @param params.clientAddress - Client (payer) Stellar public key.
 * @returns Unsigned assembled transaction ready to be signed by the wallet.
 * @throws If the escrow contract is not configured, simulation fails, or the contract rejects the call.
 */
export async function buildReleaseEscrowTransaction({
  contractId,
  jobId,
  clientAddress,
}: {
  contractId: string;
  jobId: string;
  clientAddress: string;
}) {
  if (!contractId.trim()) {
    throw new Error(
      "Escrow contract is not configured (set NEXT_PUBLIC_ESCROW_CONTRACT_ID).",
    );
  }
  const source = await server.loadAccount(clientAddress);
  const contract = new Contract(contractId);
  const clientAddr = new Address(clientAddress);
  const tx = new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "release_escrow",
        clientAddr.toScVal(),
        nativeToScVal(jobId, { type: "string" }),
      ),
    )
    .setTimeout(60)
    .build();

  const simulated = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(simulated)) {
    return rpc.assembleTransaction(tx, simulated).build();
  }
  throw formatSimulationFailure(simulated);
}

/**
 * Builds a small memo transaction to record a milestone on-chain.
 * Sends a tiny amount (0.00001 XLM) to the source account itself (circular payment).
 */
export async function buildMilestoneTransaction({
  publicKey,
  milestoneTitle,
}: {
  publicKey: string;
  milestoneTitle: string;
}) {
  const source = await server.loadAccount(publicKey);
  const builder = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: publicKey,
        asset: Asset.native(),
        amount: "0.00001",
      }),
    )
    .addMemo(Memo.text(`Milestone: ${milestoneTitle.slice(0, 17)}`))
    .setTimeout(60);

  return builder.build();
}

/** Maps Soroban simulation errors to short, user-facing messages. */
/**
 * Convert a Soroban simulation result into a user-friendly `Error`.
 *
 * @param simulated - RPC simulation response (success or failure).
 * @returns An `Error` describing the likely cause.
 * @throws Never; this function always returns an `Error` instance.
 */
export function formatSimulationFailure(simulated: unknown): Error {
  const raw = JSON.stringify(simulated);
  if (/underfunded|insufficient/i.test(raw) && /balance|fee|Fund/i.test(raw)) {
    return new Error(
      "Insufficient XLM to pay Soroban fees or complete the release. Add test XLM to this account.",
    );
  }
  if (raw.includes("Job not found")) {
    return new Error(
      "This job ID is not on the escrow contract. Fund it first with create_job using the same job ID.",
    );
  }
  if (raw.includes("Only the client can release")) {
    return new Error(
      "Connect the client wallet — only the client can release escrow.",
    );
  }
  if (raw.includes("Already released")) {
    return new Error("This escrow was already released on-chain.");
  }
  if (raw.includes("HostError") || raw.includes("VmValidation")) {
    return new Error(
      "The contract rejected this call. Check network (testnet/mainnet) and contract ID.",
    );
  }
  return new Error(
    "Could not simulate release_escrow. Verify NEXT_PUBLIC_ESCROW_CONTRACT_ID and that the job exists on-chain.",
  );
}

/** Maps Horizon submission errors to user-friendly text. */
/**
 * Convert a Horizon submission error into a short user-facing message.
 *
 * @param err - Error thrown by `server.submitTransaction`.
 * @returns Friendly error text.
 * @throws Never; this function always returns a string.
 */
export function formatTransactionError(err: unknown): string {
  const e = err as {
    response?: {
      data?: {
        extras?: {
          result_codes?: { transaction?: string; operations?: string[] };
        };
        detail?: string;
      };
    };
    message?: string;
  };
  const codes = e?.response?.data?.extras?.result_codes;
  const ops = (codes?.operations ?? []).join(" ");
  const txc = codes?.transaction ?? "";
  const blob = `${txc} ${ops}`.toLowerCase();
  if (blob.includes("underfunded") || blob.includes("op_underfunded")) {
    return "Insufficient XLM balance for network fees or the payment.";
  }
  if (
    blob.includes("insufficient_fee") ||
    blob.includes("tx_insufficient_fee")
  ) {
    return "Network fee too low. Wait and try again, or use a higher fee.";
  }
  if (blob.includes("bad_auth") || blob.includes("op_bad_auth")) {
    return "Transaction was not authorized. Use Freighter with the client account.";
  }
  if (blob.includes("tx_too_late") || blob.includes("tx_bad_seq")) {
    return "The transaction expired while it was being signed. Nothing was sent — please try again.";
  }
  if (e?.response?.data?.detail && typeof e.response.data.detail === "string") {
    return e.response.data.detail;
  }
  const msg = e?.message || String(err);
  return msg.length > 280 ? `${msg.slice(0, 280)}…` : msg;
}

/**
 * Submit a signed transaction XDR to Horizon.
 *
 * @param signedXDR - Signed transaction XDR (base64).
 * @returns Horizon submission response.
 * @throws If Horizon rejects the transaction; the error message is formatted for display.
 */
export async function submitTransaction(signedXDR: string) {
  const tx = new Transaction(signedXDR, NETWORK_PASSPHRASE);
  try {
    return await server.submitTransaction(tx);
  } catch (err: unknown) {
    throw new Error(formatTransactionError(err));
  }
}

// ── Fee estimation & Max-button math (issue #1096, Workstream 1) ─────────────

/** Stellar base fee: 100 stroops per operation. */
export const BASE_FEE_STROOPS = 100;

/** The Stellar base reserve (2 XLM) kept on every funded account. */
/**
 * Conservative minimum account balance (XLM) used as the default in
 * calculateMaxDonation when the caller has no live reserve data: 2 XLM
 * approximates (2 + subentries) × base reserve for a typical account.
 */
export const MINIMUM_BALANCE_XLM = 2;

/**
 * Stellar protocol base reserve (XLM) — 0.5 XLM since protocol 14.  Used as
 * the offline fallback by getBaseReserveXLM when Horizon is unreachable.
 */
export const BASE_RESERVE_FALLBACK_XLM = 0.5;

/** @deprecated Use MINIMUM_BALANCE_XLM or BASE_RESERVE_FALLBACK_XLM explicitly. */
export const BASE_RESERVE_XLM = MINIMUM_BALANCE_XLM;

/** 1 XLM = 10,000,000 stroops. */
export const STROOPS_PER_XLM = 10_000_000;

/**
 * Estimate the network fee for a transaction, in stroops.
 * Classic Stellar fees are a multiple of the 100-stroop base fee, one
 * unit per operation — the skeleton transaction is built with the same
 * operation list, so this is the fee Horizon will charge.
 *
 * @param operationCount - Number of operations in the transaction (>= 1).
 * @returns Fee in stroops.
 */
export function estimateFeeStroops(operationCount = 1): number {
  return BASE_FEE_STROOPS * Math.max(1, Math.floor(operationCount));
}

/**
 * Convert stroops to an XLM decimal string (e.g. 100 → "0.0000100").
 *
 * @param stroops - Amount in stroops.
 * @returns XLM amount as a decimal string.
 */
export function stroopsToXLM(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(7);
}

/**
 * Compute the maximum safe donation amount for a donor's XLM balance:
 *
 *   max = balance − base_reserve − estimated_fee − 1 stroop
 *
 * The 1-stroop margin guarantees the resulting transaction never fails
 * for a dust-size rounding shortfall, per the issue's acceptance criteria.
 *
 * @param balanceXLM - Donor's current XLM balance (decimal string or number).
 * @param baseReserveXLM - Minimum balance the account must keep (default
 *   MINIMUM_BALANCE_XLM = 2 XLM — a conservative estimate of the full
 *   (2 + subentries) × base-reserve requirement).
 * @param feeStroops - Estimated network fee in stroops.
 * @returns Max donation as an XLM decimal string, or "0" when negative.
 */
export function calculateMaxDonation(
  balanceXLM: string | number,
  baseReserveXLM = MINIMUM_BALANCE_XLM,
  feeStroops = estimateFeeStroops(1),
): string {
  const balance = typeof balanceXLM === "string" ? parseFloat(balanceXLM) : balanceXLM;
  if (!Number.isFinite(balance) || balance <= 0) return "0";
  const feeXLM = feeStroops / STROOPS_PER_XLM;
  const max = balance - baseReserveXLM - feeXLM - 1 / STROOPS_PER_XLM;
  return max > 0 ? max.toFixed(7) : "0";
}

/**
 * Human-readable fee for UI display: "0.0000100 XLM" from stroops.
 *
 * @param feeStroops - Fee in stroops.
 * @returns Formatted string, e.g. "0.0000100 XLM".
 */
export function formatFeeXLM(feeStroops: number): string {
  return `${stroopsToXLM(feeStroops)} XLM`;
}

// ── Transaction polling (issue #1096, Workstream 6) ──────────────────────────

/**
 * Poll Horizon until a submitted transaction is included in a ledger.
 *
 * Used after a submission that acknowledged the transaction but did not
 * return a final result (RPC drop / timeout), so the UI can distinguish
 * "confirmed" from "unknown" instead of showing a fake error.
 *
 * @param hash - Transaction hash (64 hex chars).
 * @param opts.timeoutMs - Stop polling after this many ms (default 60s).
 * @param opts.intervalMs - Delay between polls (default 3s).
 * @param opts.horizonServer - Injectable Horizon server (used by tests).
 * @returns The transaction record once it is included AND succeeded.
 * @throws Error("TIMEOUT") when the tx is not found before timeout.
 * @throws Error("TRANSACTION_FAILED") when the tx is included in a ledger
 *   but the payment failed on-chain (`successful: false`).
 */
export async function pollTransaction(
  hash: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    horizonServer?: Horizon.Server;
  } = {},
) {
  const { timeoutMs = 60_000, intervalMs = 3_000, horizonServer = server } = opts;
  const startedAt = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const record = await horizonServer.transactions().transaction(hash).call();
      // A record can be included in a ledger yet fail on-chain (e.g. the
      // payment op errored).  The caller must never treat that as a
      // confirmed donation — surface it as a distinct failure so the UI can
      // show an honest state instead of a false success (issue #1096, WS6).
      if (record && record.successful === false) {
        throw new Error("TRANSACTION_FAILED");
      }
      return record;
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "TRANSACTION_FAILED") {
        throw err;
      }
      // Not included yet (404) — keep polling until the deadline.
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("TIMEOUT");
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/**
 * Validate a Stellar account public key (G...).
 *
 * @param a - Candidate public key string.
 * @returns `true` if the string matches the basic public-key format.
 * @throws Never.
 */
export function isValidStellarAddress(a: string): boolean {
  return /^G[A-Z0-9]{55}$/.test(a);
}

/**
 * Build a Stellar Expert transaction URL for the current network.
 *
 * @param hash - Transaction hash.
 * @returns Explorer URL.
 * @throws Never.
 */
/**
 * Builds a Stellar transaction with a PathPaymentStrictSend operation that
 * converts a source asset to XLM and delivers it to the project wallet.
 *
 * This is used for DEX path-payment donations where the donor holds a
 * non-XLM asset (e.g. yXLM, USDT, BTC-anchored tokens) and wants to
 * donate the XLM-equivalent.
 *
 * The donor signs one atomic transaction containing:
 * 1. PathPaymentStrictSend — source_asset → XLM to project wallet
 * 2. (Optionally) a Soroban contract invocation to record on-chain
 *
 * @param params - Path payment parameters.
 * @param params.fromPublicKey - Source account public key (donor).
 * @param params.toPublicKey - Destination account public key (project wallet).
 * @param params.sendAsset - Source asset to send (e.g. "yXLM:GB…").
 * @param params.sendAmount - Decimal amount of the source asset to send.
 * @param params.destMin - Minimum XLM to receive (destination floor from DEX estimate).
 * @param params.path - Ordered list of intermediary assets for the DEX path.
 * @returns Unsigned Stellar transaction ready to be signed by the wallet.
 * @throws If Horizon fails to load the source account or parameters are invalid.
 */
export async function buildPathPaymentTransaction({
  fromPublicKey,
  toPublicKey,
  sendAsset,
  sendAmount,
  destMin,
  path = [],
  memo,
}: {
  fromPublicKey: string;
  toPublicKey: string;
  sendAsset: { code: string; issuer: string };
  sendAmount: string;
  destMin: string;
  path?: Array<{ code: string; issuer: string }>;
  memo?: string;
}) {
  const source = await server.loadAccount(fromPublicKey);
  const sendStellarAsset = new Asset(sendAsset.code, sendAsset.issuer);
  const destAsset = Asset.native();

  const pathAssets = path.map(
    (p) => new Asset(p.code, p.issuer),
  );

  const builder = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: sendStellarAsset,
        sendAmount,
        destination: toPublicKey,
        destAsset,
        destMin,
        path: pathAssets,
      }),
    )
    .setTimeout(60);

  if (memo) builder.addMemo(Memo.text(memo.slice(0, 28)));

  return builder.build();
}

/**
 * Build a Stellar Expert transaction URL for the current network.
 *
 * @param hash - Transaction hash.
 * @returns Explorer URL.
 * @throws Never.
 */
export function explorerUrl(hash: string): string {
  return `https://stellar.expert/explorer/${NETWORK === "mainnet" ? "public" : "testnet"}/tx/${hash}`;
}

/**
 * Build a Stellar Expert account URL for the current network.
 *
 * @param addr - Account public key.
 * @returns Explorer URL.
 * @throws Never.
 */
export function accountUrl(addr: string): string {
  return `https://stellar.expert/explorer/${NETWORK === "mainnet" ? "public" : "testnet"}/account/${addr}`;
}

/**
 * Queries the Soroban contract for global impact metrics.
 *
 * @returns Global impact metrics. Returns zeroed values when the contract is not configured or on errors.
 * @throws Never; errors are caught and converted to zeroed values.
 */
export async function getGlobalImpactStats() {
  if (!CONTRACT_ID) {
    console.warn("CONTRACT_ID not set, returning zero stats");
    return { totalRaisedXLM: "0", totalCO2OffsetGrams: "0", donationCount: 0 };
  }

  const contract = new Contract(CONTRACT_ID);

  try {
    const [totalRaised, totalCO2, donationCount] = await Promise.all([
      simulateCall(contract, "get_global_total"),
      simulateCall(contract, "get_global_co2"),
      simulateCall(contract, "get_donation_count"),
    ]);

    // totalRaised is in stroops (i128), totalCO2 is in grams (i128)
    return {
      totalRaisedXLM: formatNumber(Number(totalRaised) / 10_000_000, PINNED_LOCALE, {
        minimumFractionDigits: 2,
      }),
      totalCO2OffsetGrams: totalCO2.toString(),
      donationCount: Number(donationCount),
    };
  } catch (err) {
    console.error("Failed to fetch global impact stats:", err);
    return { totalRaisedXLM: "0", totalCO2OffsetGrams: "0", donationCount: 0 };
  }
}

/**
 * Queries the contract for donor statistics including badge tier.
 *
 * @param donorAddress - Donor Stellar public key.
 * @returns Donor stats, or `null` when the contract is not configured or on errors.
 * @throws Never; errors are caught and converted to `null`.
 */
export async function getDonorStats(donorAddress: string) {
  if (!CONTRACT_ID) {
    return null;
  }

  const contract = new Contract(CONTRACT_ID);

  try {
    const donor = new Address(donorAddress);
    const stats = await simulateCall(contract, "get_donor_stats", [
      donor.toScVal(),
    ]);

    return {
      totalDonated: Number(stats.total_donated) / 10_000_000,
      donationCount: Number(stats.donation_count),
      badge: stats.badge,
      co2OffsetGrams: Number(stats.co2_offset_grams),
    };
  } catch (err) {
    console.error("Failed to fetch donor stats:", err);
    return null;
  }
}

/**
 * Queries the contract for a voter's badge-weighted voting power.
 *
 * @param voterAddress - Voter Stellar public key.
 * @returns Voter weight (u32), or 0 when the contract is not configured or on errors.
 */
export async function getVoterWeight(voterAddress: string): Promise<number> {
  if (!CONTRACT_ID) {
    return 0;
  }

  const contract = new Contract(CONTRACT_ID);

  try {
    const voter = new Address(voterAddress);
    const weight = await simulateCall(contract, "get_voter_weight", [
      voter.toScVal(),
    ]);
    return Number(weight);
  } catch (err) {
    console.error("Failed to fetch voter weight:", err);
    return 0;
  }
}

/**
 * Simple djb2 hash function for donation messages.
 * Returns a 32-bit unsigned integer hash.
 *
 * @param message - Message to hash.
 * @returns Unsigned 32-bit hash.
 * @throws Never.
 */
export function hashMessage(message: string): number {
  let hash = 5381;
  for (let i = 0; i < message.length; i++) {
    hash = (hash << 5) + hash + message.charCodeAt(i);
    hash = hash >>> 0; // Convert to unsigned 32-bit integer
  }
  return hash;
}

/**
 * Stream real-time payments to a wallet address using Horizon SSE.
 * Returns a cleanup function to close the stream.
 *
 * @param walletAddress - Account to stream payments for.
 * @param onPayment - Callback invoked for each matching payment event.
 * @param cursor - Optional cursor value; defaults to "now".
 * @returns Cleanup function to stop streaming.
 * @throws Never; stream errors are surfaced via the Horizon SDK `onerror` callback.
 */
export function streamProjectPayments(
  walletAddress: string,
  onPayment: (payment: {
    id: string;
    from: string;
    amount: string;
    asset: string;
    createdAt: string;
    transactionHash: string;
  }) => void,
  cursor?: string,
): () => void {
  const builder = server
    .payments()
    .forAccount(walletAddress)
    .order("asc")
    .cursor(cursor || "now");

  const closeStream = builder.stream({
    onmessage: (record: any) => {
      if (record.type !== "payment" && record.type !== "create_account") return;
      onPayment({
        id: record.id,
        from: record.from || record.funder || record.source_account,
        amount: record.amount || record.starting_balance || "0",
        asset: record.asset_code || "XLM",
        createdAt: record.created_at,
        transactionHash: record.transaction_hash,
      });
    },
    onerror: (err: any) => {
      console.error("Horizon SSE stream error:", err);
    },
  });

  return closeStream;
}

/**
 * Stream global XLM donations and map destination accounts to known projects.
 * Returns a cleanup function to close the Horizon SSE stream.
 */
export function streamGlobalProjectDonations(
  projects: Array<{ id: string; name: string; walletAddress: string }>,
  onDonation: (donation: {
    id: string;
    projectId: string;
    projectName: string;
    amountXLM: string;
    from: string;
    createdAt: string;
    transactionHash: string;
  }) => void,
  cursor?: string,
): () => void {
  const projectByWallet = new Map(
    projects.map((project) => [project.walletAddress.toUpperCase(), project]),
  );

  const closeStream = server
    .payments()
    .cursor(cursor || "now")
    .stream({
      onmessage: (record: any) => {
        if (record.type !== "payment" && record.type !== "create_account")
          return;
        const destination = String(
          record.to || record.account || record.destination || "",
        ).toUpperCase();
        if (!destination || !projectByWallet.has(destination)) return;

        const project = projectByWallet.get(destination);
        if (!project) return;

        const isNativeXLM =
          record.asset_type === "native" ||
          !record.asset_type ||
          record.asset_code === "XLM";
        if (!isNativeXLM) return;

        const amountRaw = record.amount || record.starting_balance || "0";
        const amount = Number.parseFloat(amountRaw);
        if (!Number.isFinite(amount) || amount <= 0) return;

        onDonation({
          id: String(record.id),
          projectId: project.id,
          projectName: project.name,
          amountXLM: amount.toFixed(7),
          from:
            record.from || record.funder || record.source_account || "Unknown",
          createdAt: record.created_at || new Date().toISOString(),
          transactionHash: record.transaction_hash || "",
        });
      },
      onerror: (err: any) => {
        console.error("Global Horizon stream error:", err);
      },
    });

  return closeStream;
}

export interface ProjectDiscussionMessage {
  id: string;
  from: string;
  amount: string;
  memo: string;
  createdAt: string;
  transactionHash: string;
}

/**
 * Fetches recent donation memos for a project's wallet address by reading Horizon payment
 * history and joining it with the transaction memo.
 *
 * Notes:
 * - Only text memos are supported (memo_type === "text").
 * - Memo length on Stellar is limited; DonateForm caps to 100 chars for UX but on-chain
 *   the memo will be truncated by wallets/SDKs if too long.
 */
export async function fetchProjectDiscussion(
  walletAddress: string,
  limit = 50,
): Promise<ProjectDiscussionMessage[]> {
  const payments = await server
    .payments()
    .forAccount(walletAddress)
    .order("desc")
    .limit(limit)
    .call();

  const rows = (payments?.records ?? []) as any[];
  const donationPayments = rows.filter(
    (r) =>
      (r.type === "payment" || r.type === "create_account") &&
      typeof r.transaction_hash === "string" &&
      r.transaction_hash,
  );

  const txHashes = Array.from(
    new Set(donationPayments.map((p) => p.transaction_hash as string)),
  ).slice(0, limit);

  const txMemoByHash = new Map<string, string>();
  const txCreatedAtByHash = new Map<string, string>();

  const txResults = await Promise.allSettled(
    txHashes.map(async (h) => {
      const tx = await server.transactions().transaction(h).call();
      const memoType = (tx as any).memo_type as string | undefined;
      const memo = (tx as any).memo as string | undefined;
      const createdAt = (tx as any).created_at as string | undefined;
      if (memoType === "text" && memo && createdAt) {
        txMemoByHash.set(h, memo);
        txCreatedAtByHash.set(h, createdAt);
      }
    }),
  );
  // Avoid unused lint warnings in some configs
  void txResults;

  const messages: ProjectDiscussionMessage[] = donationPayments
    .map((p) => {
      const hash = p.transaction_hash as string;
      const memo = txMemoByHash.get(hash);
      const createdAt = txCreatedAtByHash.get(hash) || p.created_at;
      if (!memo || !createdAt) return null;
      return {
        id: `${p.id}`,
        from: p.from || p.funder || p.source_account,
        amount: p.amount || p.starting_balance || "0",
        memo,
        createdAt,
        transactionHash: hash,
      };
    })
    .filter(Boolean) as ProjectDiscussionMessage[];

  // Chronological feed (oldest → newest)
  messages.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return messages;
}

async function simulateCall(
  contract: Contract,
  method: string,
  args: any[] = [],
) {
  // We use a dummy account for simulation
  const dummyAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "-1",
  );
  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const result = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationSuccess(result)) {
    return scValToNative(result.result!.retval);
  }
  throw new Error(`Simulation failed for ${method}: ${JSON.stringify(result)}`);
}

/**
 * Builds a Soroban transaction that calls `approve(from, spender, amount, expiration_ledger)`
 * on a Stellar asset/SAC token contract.
 */
export async function buildApproveTransaction({
  tokenAddress,
  user,
  spender,
  amount,
}: {
  tokenAddress: string;
  user: string;
  spender: string;
  amount: string;
}) {
  const source = await server.loadAccount(user);
  const tokenContract = new Contract(tokenAddress);
  const userAddress = new Address(user);
  const spenderAddress = new Address(spender);
  const amountInStroops = Math.floor(parseFloat(amount) * 10_000_000);

  // Set a very high expiration ledger (e.g. current + 2,000,000 ledgers)
  const currentLedger = await rpcServer.getLatestLedger();
  const expirationLedger = currentLedger.sequence + 2000000;

  const builder = new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      tokenContract.call(
        "approve",
        userAddress.toScVal(),
        spenderAddress.toScVal(),
        nativeToScVal(amountInStroops, { type: "i128" }),
        nativeToScVal(expirationLedger, { type: "u32" }),
      )
    )
    .setTimeout(60);

  const tx = builder.build();
  const simulated = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationSuccess(simulated)) {
    return rpc.assembleTransaction(tx, simulated).build();
  } else {
    throw formatSimulationFailure(simulated);
  }
}

