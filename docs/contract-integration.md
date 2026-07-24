# Stellar-IndigoPay Smart Contract Integration Guide

This guide enables third-party developers to integrate with the **Stellar-IndigoPay Donation Contract** on Stellar Soroban. You can record donations from your own contracts, query donor statistics, and leverage badge tiers in your dApps.

**Table of Contents**

- [Overview](#overview)
- [Contract Addresses](#contract-addresses)
- [Core Concepts](#core-concepts)
- [Recording Donations (Cross-Contract Calls)](#recording-donations-cross-contract-calls)
- [Querying Donor Statistics](#querying-donor-statistics)
- [On-Chain Donation Receipts](#on-chain-donation-receipts)
- [Badge Tiers & Thresholds](#badge-tiers--thresholds)
- [TypeScript Client Examples](#typescript-client-examples)
- [Complete Soroban Contract Example](#complete-soroban-contract-example)
- [Error Handling & Best Practices](#error-handling--best-practices)
- [Testing](#testing)

---

## Overview

The Stellar-IndigoPay contract is a **climate donation tracking system** on Stellar Soroban that:

- **Records donations** immutably on-chain with project, donor, and amount
- **Calculates donor badges** based on cumulative lifetime donations
- **Tracks CO₂ impact** per donation using project-specific offsets
- **Generates cryptographically signed receipts** that donors can export for tax purposes
- **Enables cross-contract calls** so your contracts can integrate with Stellar-IndigoPay

Your contract can:

1. Call `donate()` to record a climate donation on behalf of your users
2. Query `get_donor_stats()` to show a donor's impact and badge tier
3. Generate/verify donation receipts via `generate_receipt()` and `verify_receipt()`
4. Build impact-driven features on top of Stellar-IndigoPay data

### Key Advantage

Unlike off-chain databases, all donation data is **cryptographically verified** on the Stellar blockchain. Users can prove their impact independently.

---

## Contract Addresses

Replace these with values from your `.env` or deployment manifest:

| Network     | Environment Variable      | Example                       |
| ----------- | ------------------------- | ----------------------------- |
| **Testnet** | `NEXT_PUBLIC_CONTRACT_ID` | `CDMLFMKMMD...` (from `.env`) |
| **Mainnet** | `NEXT_PUBLIC_CONTRACT_ID` | _(deploy your own; link TBD)_ |

Also needed:

- **Stellar Network Passphrase**: `Test SDF Network ; September 2015` (testnet) or `Public Global Stellar Network ; September 2015` (mainnet)
- **Soroban RPC URL**: `https://soroban-testnet.stellar.org` (testnet)
- **Token Contract** (typically XLM wrapped as a Soroban token): `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4`

---

## Core Concepts

### Data Structures

#### **DonorStats**

Returned by `get_donor_stats(donor: Address)`.

```rust
pub struct DonorStats {
    pub total_donated:    i128,        // XLM in stroops (1 XLM = 10_000_000 stroops)
    pub donation_count:   u32,         // Number of times this donor has donated
    pub badge:            BadgeTier,   // Current impact badge (None, Seedling, Tree, Forest, EarthGuardian)
    pub co2_offset_grams: i128,        // Estimated CO₂ offset (grams)
}
```

#### **DonationReceipt**

Returned by `generate_receipt(donor: Address, donation_index: u32)`.

```rust
pub struct DonationReceipt {
    pub donation_index: u32,           // Which donation this receipt is for
    pub donor: Address,                // The donor (must match the donation record)
    pub project_id: String,            // Project that received the donation
    pub amount: i128,                  // Amount in stroops
    pub co2_offset: i128,              // CO₂ offset in grams
    pub ledger: u32,                   // Ledger sequence when donation occurred
    pub currency: Symbol,              // "XLM" or "USDC"
    pub contract_signature: BytesN<32>,// SHA-256 cryptographic commitment
}
```

The `contract_signature` is a SHA-256 hash of the deterministic XDR encoding of all other fields. Anyone can verify a receipt by recomputing the hash and comparing it to this value — no full donation history query needed.

#### **Project**

Returned by `get_project(id: String)`.

```rust
pub struct Project {
    pub id:            String,        // Unique project ID (e.g., "amazon-reforestation")
    pub name:          String,        // Human-readable name
    pub wallet:        Address,       // Destination wallet that receives donations
    pub co2_per_xlm:   u32,           // CO₂ offset (grams per 1 XLM donated)
    pub total_raised:  i128,          // Total XLM raised (stroops)
    pub donor_count:   u32,           // Count of unique donors
    pub active:        bool,          // Whether project accepts new donations
    pub registered_at: u32,           // Ledger sequence when registered
}
```

#### **BadgeTier** (Enum)

Represents donor impact level based on cumulative donations.

| Tier            | Min XLM | Interpretation   |
| --------------- | ------- | ---------------- |
| `None`          | 0       | No donations yet |
| `Seedling`      | 10      | Emerging donor   |
| `Tree`          | 100     | Committed donor  |
| `Forest`        | 500     | Major donor      |
| `EarthGuardian` | 2,000   | Impact champion  |

---

## Recording Donations (Cross-Contract Calls)

### Step 1: Understand the `donate()` Function

The Stellar-IndigoPay contract's `donate()` function records a donation and transfers XLM to the project wallet.

**Signature:**

```rust
pub fn donate(
    env:        Env,
    token:      Address,           // Token contract (e.g., XLM wrapper)
    donor:      Address,           // Who is donating (must authorize)
    project_id: String,            // Target project ID
    amount:     i128,              // Amount in stroops
    msg_hash:   u32,               // Message hash (for UI reference, e.g., impact message ID)
) -> Result<(), String>
```

**Authorization Requirements:**

- The `donor` must have signed the transaction (via `require_auth()`)
- The `donor` must have sufficient XLM balance
- The project must be `active`

**What it does:**

1. Transfers `amount` XLM from `donor` to the project's wallet
2. Updates donor's cumulative stats (`total_donated`, `donation_count`)
3. Recalculates and updates the donor's badge tier
4. Increments project's `total_raised` and `donor_count`
5. Calculates CO₂ offset: `co2_offset = (amount / 10_000_000) * project.co2_per_xlm`
6. Emits a `donated` event with (donor, project_id, amount, badge, msg_hash)

### Step 2: Call from Your Soroban Contract

If you're building a **Soroban contract** that integrates with Stellar-IndigoPay, here's how to invoke `donate()`:

```rust
// In your contract's Rust code:
use soroban_sdk::{Contract, ContractClient, Address, Env, String};

#[contractimpl]
impl YourContract {
    pub fn contribute_to_climate(
        env: Env,
        indigopay_contract_id: Address,
        donor: Address,
        project_id: String,
        amount: i128,
        msg_hash: u32,
    ) {
        // Create a client to the Stellar-IndigoPay contract
        let indigopay_client = ContractClient::new(&env, &indigopay_contract_id);

        // Call donate() on Stellar-IndigoPay
        // The donor must have authorized this transaction
        indigopay_client.donate(
            &token_address,     // XLM token contract address
            &donor,
            &project_id,
            &amount,
            &msg_hash,
        );
    }
}
```

### Step 3: Call from the Frontend (TypeScript/JavaScript)

If you're submitting a transaction from a frontend app or server, use TypeScript with the Stellar SDK:

See [TypeScript Client Examples](#typescript-client-examples) below for a complete implementation.

---

## Querying Donor Statistics

### Query 1: Get Full Donor Stats

**Function:** `get_donor_stats(donor: Address) -> DonorStats`

Returns the donor's cumulative statistics, including their current badge tier.

**TypeScript Example:**

```typescript
import { rpc, Contract, Address } from "@stellar/stellar-sdk";

const rpcServer = new rpc.Server("https://soroban-testnet.stellar.org");
const contractId = "CABC..."; // Your Stellar-IndigoPay contract ID

async function getDonorStats(donorPublicKey: string): Promise<any> {
  const contract = new Contract(contractId);

  // Prepare the read-only contract invocation
  const tx = new TransactionBuilder(/* ... */)
    .addOperation(
      contract.call("get_donor_stats", new Address(donorPublicKey).toScVal()),
    )
    .build();

  // Submit to Soroban RPC
  const response = await rpcServer.getTransaction(/* hash */);
  const result = response.result_meta_xdr; // Parse result

  // Returns: { total_donated, donation_count, badge, co2_offset_grams }
}
```

**Response Format:**

```json
{
  "total_donated": 50000000, // 5 XLM in stroops
  "donation_count": 3, // 3 donations
  "badge": "Tree", // Badge tier enum (serialized as string in JSON)
  "co2_offset_grams": 1500000 // ~1500 kg CO₂
}
```

### Query 2: Get Current Badge Tier

**Function:** `get_badge(donor: Address) -> BadgeTier`

Returns only the donor's badge tier (lighter query).

```typescript
async function getDonorBadge(donorPublicKey: string): Promise<string> {
  // Similar to getDonorStats, but call "get_badge" instead
  // Returns: "None" | "Seedling" | "Tree" | "Forest" | "EarthGuardian"
}
```

### Query 3: Get Project Stats

**Function:** `get_project(project_id: String) -> Project`

Query a project's totals and donor metrics.

```typescript
async function getProjectStats(projectId: string): Promise<any> {
  const contract = new Contract(contractId);

  // Prepare the read-only call
  const tx = new TransactionBuilder(/* ... */)
    .addOperation(
      contract.call(
        "get_project",
        nativeToScVal(projectId, { type: "string" }),
      ),
    )
    .build();

  // Returns: { id, name, wallet, co2_per_xlm, total_raised, donor_count, active, registered_at }
}
```

### Query 4: Global Impact

**Functions:**

- `get_global_total() -> i128` — Total XLM raised platform-wide
- `get_global_co2() -> i128` — Total CO₂ offset (grams) platform-wide
- `get_donation_count() -> u32` — Total number of donations recorded
- `get_project_count() -> u32` — Total projects registered

```typescript
async function getGlobalStats(): Promise<any> {
  const contract = new Contract(contractId);

  // Build multiple calls in one transaction
  const ops = [
    contract.call("get_global_total"),
    contract.call("get_global_co2"),
    contract.call("get_donation_count"),
    contract.call("get_project_count"),
  ];

  // Submit to RPC and parse results
}
```

---

## On-Chain Donation Receipts

### Overview

Each donation on Stellar-IndigoPay can produce a **cryptographically signed receipt** that the donor can export and use for tax purposes. The receipt includes a SHA-256 commitment to the donation details (amount, project, timestamp, CO₂ offset), verifiable off-chain without querying the full donation history.

### Receipt Generation

**Function:** `generate_receipt(donor: Address, donation_index: u32) -> DonationReceipt`

Only the donor can generate a receipt for their own donation. The receipt is **deterministic** — calling `generate_receipt` twice with the same donor and donation_index returns the identical receipt.

### Receipt Verification

**Function:** `verify_receipt(receipt: DonationReceipt) -> bool`

Anyone can verify a receipt against on-chain data. Returns `true` if:
- The referenced donation index exists on-chain
- All receipt fields (donor, project_id, amount, ledger, currency) match the on-chain record
- The CO₂ offset matches the on-chain value
- The `contract_signature` matches a recomputed SHA-256 hash of the receipt fields

Returns `false` for tampered receipts or non-existent donations.

### TypeScript Example

```typescript
import { rpc, Contract, Address, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

const rpcServer = new rpc.Server("https://soroban-testnet.stellar.org");
const contractId = "CABC..."; // Your Stellar-IndigoPay contract ID

/**
 * Generate a donation receipt for a specific donation.
 * Only the donor can call this.
 */
async function generateReceipt(
  donorPublicKey: string,
  donationIndex: number,
): Promise<any> {
  const contract = new Contract(contractId);

  // Build the transaction
  const tx = new TransactionBuilder(
    { source: donorPublicKey } as any,
    { fee: "1000000", networkPassphrase: "Test SDF Network ; September 2015" },
  )
    .addOperation(
      contract.call(
        "generate_receipt",
        new Address(donorPublicKey).toScVal(),
        nativeToScVal(donationIndex, { type: "u32" }),
      ),
    )
    .setTimeout(60)
    .build();

  // Simulate and submit
  const simulated = await rpcServer.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulated)) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulated.error)}`);
  }

  const assembled = rpc.assembleTransaction(tx, simulated).build();
  // Sign and send...

  // Parse the result
  const resultXdr = simulated.results?.[0]?.xdr;
  if (!resultXdr) throw new Error("No result");
  return scValToNative(resultXdr);
}

/**
 * Verify a donation receipt against on-chain data.
 * Anyone can call this — no authentication required.
 */
async function verifyReceipt(receipt: any): Promise<boolean> {
  const contract = new Contract(contractId);

  // Build a read-only call
  const dummyAccount = {
    source: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  };

  const tx = new TransactionBuilder(dummyAccount as any, {
    fee: "100",
    networkPassphrase: "Test SDF Network ; September 2015",
  })
    .addOperation(
      contract.call("verify_receipt", nativeToScVal(receipt, { type: "struct" })),
    )
    .setTimeout(60)
    .build();

  const simulated = await rpcServer.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulated)) {
    throw new Error(`Verification simulation failed`);
  }

  const resultXdr = simulated.results?.[0]?.xdr;
  return scValToNative(resultXdr);
}

// Usage:
// const receipt = await generateReceipt(donorPublicKey, 0);
// console.log(`Receipt signature: ${receipt.contract_signature}`);
//
// const isValid = await verifyReceipt(receipt);
// console.log(`Receipt valid: ${isValid}`);
```

### Off-Chain Verification

Since the `contract_signature` is a simple SHA-256 hash of the deterministic XDR encoding of the receipt fields, it can also be verified **off-chain** without any RPC call:

1. Serialize the receipt fields (donation_index, donor, project_id, amount, co2_offset, ledger, currency) using the same XDR encoding
2. Compute SHA-256 of those bytes
3. Compare with `receipt.contract_signature`

```typescript
import { xdr } from "@stellar/stellar-sdk";
import { createHash } from "crypto";

function verifyReceiptOffChain(receipt: any): boolean {
  // Reconstruct the XDR bytes using the same field order as the contract
  const fields = {
    donation_index: receipt.donation_index,
    donor: receipt.donor,
    project_id: receipt.project_id,
    amount: receipt.amount,
    co2_offset: receipt.co2_offset,
    ledger: receipt.ledger,
    currency: receipt.currency,
  };

  // In practice, serialize using the Stellar XDR library
  // and compute SHA-256. The exact XDR encoding depends on the
  // Soroban SDK version — see ReceiptFields in the contract source.
  const computedHash = createHash("sha256")
    .update(JSON.stringify(fields)) // Replace with actual XDR serialization
    .digest("hex");

  return computedHash === receipt.contract_signature;
}
```

### Receipt Event

When a donor generates a receipt, the contract emits a `receipt_gen` event with topics `["receipt_gen", donor]` and data `(donation_index, amount, project_id, co2_offset)`. Indexers can listen for these events to track receipt generation activity.

---

## Badge Tiers & Thresholds

Badge tiers are **automatically calculated** when a donor's cumulative total exceeds thresholds.

### Tier Progression

| Tier              | Threshold | XLM Range    | Interpretation         |
| ----------------- | --------- | ------------ | ---------------------- |
| **None**          | < 10      | 0–9.99       | Inactive or new donor  |
| **Seedling**      | ≥ 10      | 10–99.99     | First impact milestone |
| **Tree**          | ≥ 100     | 100–499.99   | Consistent donor       |
| **Forest**        | ≥ 500     | 500–1,999.99 | Major contributor      |
| **EarthGuardian** | ≥ 2,000   | 2,000+       | Impact champion        |

### Key Points

1. **Monotonic progression**: Once a donor reaches a tier, they never fall back (cumulative total only increases).
2. **Automatic minting**: When a donor reaches a new tier, an impact NFT is automatically minted for them.
3. **Governance**: Badge holders (Seedling and above) can vote to verify new projects via community proposals.
4. **Query anytime**: Use `get_donor_stats()` to check the current badge at any time.

### Example: Displaying Badges

```typescript
function renderBadge(badge: string): string {
  const badges: Record<string, string> = {
    None: "🌱 No badge yet",
    Seedling: "🌱 Seedling ($10+)",
    Tree: "🌳 Tree ($100+)",
    Forest: "🌲 Forest ($500+)",
    EarthGuardian: "🌍 Earth Guardian ($2,000+)",
  };
  return badges[badge] || "Unknown";
}

async function displayDonorImpact(donorPublicKey: string) {
  const stats = await getDonorStats(donorPublicKey);
  const xlm = stats.total_donated / 10_000_000;
  const co2Kg = stats.co2_offset_grams / 1_000_000;

  console.log(`
    💰 Total Donated: ${xlm.toFixed(2)} XLM
    🎁 Badge: ${renderBadge(stats.badge)}
    🌍 CO₂ Offset: ${co2Kg.toFixed(1)} kg
    📊 Donations: ${stats.donation_count}
  `);
}
```

---

## TypeScript Client Examples

### Example 1: Basic Donation via TypeScript

Call the Stellar-IndigoPay contract's `donate()` function from TypeScript to record a donation.

```typescript
import {
  Horizon,
  TransactionBuilder,
  Networks,
  Contract,
  Address as SorobanAddress,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";

const NETWORK = "testnet";
const NETWORK_PASSPHRASE = Networks.TESTNET_NETWORK_PASSPHRASE;
const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const CONTRACT_ID = "CABC..."; // Your Stellar-IndigoPay contract ID
const TOKEN_ADDRESS =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"; // Native XLM token

const horizonServer = new Horizon.Server(HORIZON_URL);
const rpcServer = new rpc.Server(RPC_URL);

/**
 * Record a donation from a donor to a project via the Stellar-IndigoPay contract.
 *
 * @param donorPublicKey - Donor's public key (must have funds)
 * @param projectId - Target project ID (e.g., "amazon-reforestation")
 * @param amountXLM - Donation amount in XLM (will be converted to stroops)
 * @param msgHash - Optional message ID (for UI tracking)
 * @returns Transaction hash
 */
async function recordDonation(
  donorPublicKey: string,
  projectId: string,
  amountXLM: number,
  msgHash: number = 0,
): Promise<string> {
  // Step 1: Load the donor's account to build the transaction
  const donorAccount = await horizonServer.loadAccount(donorPublicKey);

  // Step 2: Convert XLM to stroops (1 XLM = 10,000,000 stroops)
  const amountInStroops = Math.floor(amountXLM * 10_000_000);

  // Step 3: Create a contract client and prepare the donate() call
  const contract = new Contract(CONTRACT_ID);

  const builder = new TransactionBuilder(donorAccount, {
    fee: "1000000", // Soroban calls require higher fees (1 million stroops = 0.1 XLM)
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "donate",
        new SorobanAddress(TOKEN_ADDRESS).toScVal(),
        new SorobanAddress(donorPublicKey).toScVal(),
        nativeToScVal(projectId, { type: "string" }),
        nativeToScVal(amountInStroops, { type: "i128" }),
        nativeToScVal(msgHash, { type: "u32" }),
      ),
    )
    .setTimeout(60)
    .build();

  // Step 4: Simulate the transaction to get resource fees
  const simulated = await rpcServer.simulateTransaction(builder);

  if (!rpc.Api.isSimulationSuccess(simulated)) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulated.error)}`);
  }

  // Step 5: Assemble the transaction with simulation results
  const assembled = rpc.assembleTransaction(builder, simulated).build();

  // Step 6: Sign the transaction
  // (In a real app, use the user's wallet extension or keypair)
  // assembled.sign(keypair);

  // Step 7: Submit to Soroban RPC
  const response = await rpcServer.sendTransaction(assembled);

  console.log(`Transaction submitted: ${response.hash}`);
  console.log(`Status: ${response.status}`);

  // Step 8: Wait for finality
  if (response.status === "PENDING") {
    let result;
    let attempts = 0;
    while (attempts < 30) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
      result = await rpcServer.getTransaction(response.hash);

      if (result.status === "SUCCESS") {
        console.log("Donation recorded successfully!");
        return response.hash;
      } else if (result.status === "FAILED") {
        throw new Error(`Transaction failed: ${result.result_xdr}`);
      }
      attempts++;
    }
    throw new Error("Transaction timed out");
  }

  return response.hash;
}

// Usage:
// const txHash = await recordDonation(
//   "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTnyqgshesvxniur3VTOLW473",
//   "amazon-reforestation",
//   50,    // 50 XLM
//   12345  // Optional message hash
// );
```

### Example 2: Query Donor Impact

Retrieve and display a donor's statistics and badge tier.

```typescript
/**
 * Query the Stellar-IndigoPay contract for a donor's stats.
 *
 * @param donorPublicKey - Donor's public key
 * @returns Donor stats including badge tier
 */
async function queryDonorStats(donorPublicKey: string): Promise<{
  totalDonatedXLM: number;
  donationCount: number;
  badge: string;
  co2OffsetKg: number;
}> {
  // Create a read-only contract call
  const contract = new Contract(CONTRACT_ID);

  // Build a dummy account to submit the read-only call
  // (No funds needed for read-only queries)
  const dummyAccount = new Horizon.Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0",
  );

  const builder = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "get_donor_stats",
        new SorobanAddress(donorPublicKey).toScVal(),
      ),
    )
    .setTimeout(60)
    .build();

  // Simulate to get the result
  const simulated = await rpcServer.simulateTransaction(builder);

  if (!rpc.Api.isSimulationSuccess(simulated)) {
    throw new Error(`Query failed: ${JSON.stringify(simulated.error)}`);
  }

  // Parse the result
  // The result is in simulated.results[0].xdr
  const resultXdr = simulated.results?.[0]?.xdr;
  if (!resultXdr) {
    throw new Error("No result in simulation response");
  }

  // Decode the XDR result (returns a Soroban value)
  // This requires using @stellar/stellar-sdk's scValToNative function
  const { scValToNative } = require("@stellar/stellar-sdk");
  const nativeResult = scValToNative(resultXdr);

  return {
    totalDonatedXLM: nativeResult.total_donated / 10_000_000,
    donationCount: nativeResult.donation_count,
    badge: nativeResult.badge,
    co2OffsetKg: nativeResult.co2_offset_grams / 1_000_000,
  };
}

// Usage:
// const stats = await queryDonorStats("GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTNYQGSHESVXNIUR3VTOLW473");
// console.log(`Badge: ${stats.badge}, Total: ${stats.totalDonatedXLM} XLM`);
```

### Example 3: Badge Verification Logic

Verify that a donor holds a specific badge tier (useful for gating features).

```typescript
const BADGE_THRESHOLDS = {
  Seedling: 10,
  Tree: 100,
  Forest: 500,
  EarthGuardian: 2000,
};

/**
 * Check if a donor has reached a specific badge tier.
 */
async function hasBadgeTier(
  donorPublicKey: string,
  requiredTier: string,
): Promise<boolean> {
  const stats = await queryDonorStats(donorPublicKey);
  const badges = ["Seedling", "Tree", "Forest", "EarthGuardian"];
  const currentIndex = badges.indexOf(stats.badge);
  const requiredIndex = badges.indexOf(requiredTier);

  return currentIndex >= requiredIndex;
}

// Usage: Gate a feature for major donors (Forest tier and above)
// if (await hasBadgeTier(userPublicKey, "Forest")) {
//   showExclusiveFeature();
// }
```

### Example 4: Batch Query Global Stats

Query platform-wide impact metrics.

```typescript
/**
 * Get global platform impact metrics.
 */
async function getGlobalImpact(): Promise<{
  totalXLMRaised: number;
  totalCO2OffsetKg: number;
  totalDonations: number;
  totalProjects: number;
}> {
  const contract = new Contract(CONTRACT_ID);
  const dummyAccount = new Horizon.Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0",
  );

  // Query each metric
  const metrics = await Promise.all([
    simulateContractCall(dummyAccount, "get_global_total"),
    simulateContractCall(dummyAccount, "get_global_co2"),
    simulateContractCall(dummyAccount, "get_donation_count"),
    simulateContractCall(dummyAccount, "get_project_count"),
  ]);

  return {
    totalXLMRaised: metrics[0] / 10_000_000,
    totalCO2OffsetKg: metrics[1] / 1_000_000,
    totalDonations: metrics[2],
    totalProjects: metrics[3],
  };
}

async function simulateContractCall(
  account: Horizon.Account,
  functionName: string,
): Promise<number> {
  const contract = new Contract(CONTRACT_ID);
  const builder = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(functionName))
    .setTimeout(60)
    .build();

  const simulated = await rpcServer.simulateTransaction(builder);
  if (!rpc.Api.isSimulationSuccess(simulated)) {
    throw new Error(`Failed to query ${functionName}`);
  }

  // Parse and return the result
  const { scValToNative } = require("@stellar/stellar-sdk");
  return scValToNative(simulated.results?.[0]?.xdr);
}
```

---

## Complete Soroban Contract Example

Here's a **full example Soroban contract** that integrates with Stellar-IndigoPay to record donations:

```rust
// File: contracts/example-partner-contract/src/lib.rs
// This contract partners with Stellar-IndigoPay to record climate donations

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token,
    Address, Env, String, Vec,
};    /// Track a match: when a user donates X, we donate Y to Stellar-IndigoPay
#[contracttype]
#[derive(Clone, Debug)]
pub struct MatchOffer {
    pub id: String,
    pub match_ratio: u32,        // e.g., 50 = 1:2 match (for every 1 XLM, we add 2)
    pub indigopay_project: String, // IndigoPay project ID
    pub total_matched: i128,     // Total XLM we've matched so far
    pub active: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Offer(String),
    UserContribution(String, Address),
}

#[contract]
pub struct PartnerContract;

#[contractimpl]
impl PartnerContract {
    /// Admin initializes the partner contract
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Admin creates a match offer
    pub fn create_match_offer(
        env: Env,
        admin: Address,
        offer_id: String,
        match_ratio: u32,
        indigopay_project: String,
    ) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance()
            .get(&DataKey::Admin).expect("Not initialized");
        if stored_admin != admin {
            panic!("Only admin can create offers");
        }

        let offer = MatchOffer {
            id: offer_id.clone(),
            match_ratio,
            indigopay_project,
            total_matched: 0,
            active: true,
        };
        env.storage().instance().set(&DataKey::Offer(offer_id), &offer);
    }

    /// User donates; we match their donation and record both donations to Stellar-IndigoPay
    pub fn donate_with_match(
        env: Env,
        token: Address,
        indigopay_contract: Address,
        donor: Address,
        offer_id: String,
        donation_amount: i128,
    ) {
        donor.require_auth();

        // Load the match offer
        let offer: MatchOffer = env.storage().instance()
            .get(&DataKey::Offer(offer_id.clone()))
            .expect("Offer not found");

        if !offer.active {
            panic!("Offer is not active");
        }

        // Calculate our match contribution
        let our_match = (donation_amount / 100) * (offer.match_ratio as i128);

        // Record user's donation to Stellar-IndigoPay
        let indigopay_client = token::Client::new(&env, &indigopay_contract);

        // Invoke Stellar-IndigoPay's donate() function
        // In a real contract, you'd use the contract client:
        let contract = soroban_sdk::Contract::new(&env, &indigopay_contract);
        contract.call(
            "donate",
            &[
                token.to_scval(),
                donor.to_scval(),
                offer.indigopay_project.to_scval(),
                soroban_sdk::Val::from_u128(&donation_amount),
                soroban_sdk::Val::from_u32(&0),
            ],
        );

        // (In production, transfer funds from partner contract to cover the match)
        // let token_client = token::Client::new(&env, &token);
        // token_client.transfer(&env.current_contract_address(), &project_wallet, &our_match);

        // Update state
        env.storage().instance().set(
            &DataKey::UserContribution(offer_id.clone(), donor.clone()),
            &(donation_amount + our_match),
        );

        env.events().publish(
            (soroban_sdk::symbol_short!("match_done"),),
            (donor, donation_amount, our_match),
        );
    }
}
```

### Deployment & Testing

```bash
# Build the contract
cd contracts/example-partner-contract
cargo build --target wasm32-unknown-unknown --release

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/example_partner_contract.wasm \
  --source <your-key> \
  --network testnet

# Initialize
stellar contract invoke \
  --id <deployed-contract-id> \
  --source <admin-key> \
  --network testnet \
  -- initialize --admin <admin-key>
```

---

## Error Handling & Best Practices

### Common Errors and Recovery

| Error                                | Cause                      | Solution                                                 |
| ------------------------------------ | -------------------------- | -------------------------------------------------------- |
| `Project not found`                  | Invalid `project_id`       | Verify project ID exists; query `get_project()` first    |
| `Project is not accepting donations` | Project is `active: false` | Contact project admin; can't donate to inactive projects |
| `Donation amount must be positive`   | `amount <= 0`              | Ensure donation amount is > 0                            |
| `Only badge holders can vote`        | Voter has no badge         | Donor must have donated ≥ 10 XLM first                   |
| `Donation record not found`          | Invalid `donation_index`   | Verify donation index against `get_donation_count()`     |
| `Only the donor can generate a receipt` | Wrong donor            | Call `generate_receipt` with the actual donor address    |
| `Simulation failed`                  | Contract logic error       | Check contract logs; verify gas is sufficient            |
| `Transaction timed out`              | RPC server slow            | Retry or increase timeout; check network status          |

### Best Practices

1. **Validate project IDs** before submitting:

   ```typescript
   async function validateProject(projectId: string): Promise<boolean> {
     try {
       await queryProjectStats(projectId);
       return true;
     } catch {
       return false;
     }
   }
   ```

2. **Use higher fees** for contract calls (0.1–1.0 XLM) vs. payments (0.00001 XLM):

   ```typescript
   const fee = "1000000"; // 0.1 XLM for Soroban calls
   ```

3. **Check badge tiers** before gating features:

   ```typescript
   if (stats.badge === "Forest" || stats.badge === "EarthGuardian") {
     // Show exclusive feature
   }
   ```

4. **Display CO₂ impact accurately**:

   ```typescript
   const co2Kg = stats.co2_offset_grams / 1_000_000;
   console.log(`${co2Kg.toFixed(1)} kg CO₂ offset`);
   ```

5. **Handle stroops carefully** (1 XLM = 10,000,000 stroops):

   ```typescript
   const xlm = stroops / 10_000_000;
   const stroops = xlm * 10_000_000;
   ```

6. **Poll transaction status** with exponential backoff:

   ```typescript
   let attempts = 0;
   while (attempts < 30) {
     const result = await rpcServer.getTransaction(hash);
     if (result.status !== "PENDING") return result;
     await sleep(Math.min(1000 * Math.pow(1.5, attempts), 5000));
     attempts++;
   }
   ```

7. **Cache badge thresholds** locally to avoid repeated queries:
   ```typescript
   const BADGE_TIERS = {
     Seedling: 10 * 10_000_000, // 10 XLM in stroops
     Tree: 100 * 10_000_000, // 100 XLM
     Forest: 500 * 10_000_000, // 500 XLM
     EarthGuardian: 2000 * 10_000_000, // 2000 XLM
   };
   ```

---

## Testing

### Unit Tests (Rust)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger as _}, Address, Env, String};

    #[test]
    fn test_donate_and_get_stats() {
        let env = Env::default();
        let id = env.register_contract(None, IndigoPayContract);
        let client = IndigoPayContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        let donor = Address::generate(&env);

        // Initialize
        client.initialize(&admin);

        // Register a project
        client.register_project(
            &admin,
            &String::from_str(&env, "test-project"),
            &String::from_str(&env, "Test Project"),
            &admin, // Project wallet
            &100,   // 100 grams CO₂ per XLM
        );

        // Donate 100 XLM
        let amount = 100 * 10_000_000; // stroops
        client.donate(
            &admin, // token (mock)
            &donor,
            &String::from_str(&env, "test-project"),
            &amount,
            &0,
        );

        // Check stats
        let stats = client.get_donor_stats(&donor);
        assert_eq!(stats.total_donated, amount);
        assert_eq!(stats.donation_count, 1);
        assert_eq!(stats.badge, BadgeTier::Tree); // ≥ 100 XLM
    }
}
```

### Integration Tests (TypeScript)

```typescript
import { test, expect } from "@jest/globals";
import { recordDonation, queryDonorStats } from "./stellar-client";

test("Record donation and verify stats", async () => {
  const donorPublicKey =
    "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTNYQGSHESVXNIUR3VTOLW473";

  // Record 50 XLM donation
  const txHash = await recordDonation(
    donorPublicKey,
    "amazon-reforestation",
    50,
  );
  expect(txHash).toBeDefined();

  // Query donor stats
  const stats = await queryDonorStats(donorPublicKey);
  expect(stats.totalDonatedXLM).toBeCloseTo(50, 1);
  expect(stats.badge).toBe("Seedling");
});

test("Generate and verify donation receipt", async () => {
  const donorPublicKey =
    "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTNYQGSHESVXNIUR3VTOLW473";

  // Record a donation
  await recordDonation(donorPublicKey, "amazon-reforestation", 25);

  // Generate receipt for donation index 0
  const receipt = await generateReceipt(donorPublicKey, 0);
  expect(receipt.donation_index).toBe(0);
  expect(receipt.amount).toBeGreaterThan(0);
  expect(receipt.contract_signature).toBeDefined();

  // Verify the receipt
  const isValid = await verifyReceipt(receipt);
  expect(isValid).toBe(true);

  // Tamper with the receipt and verify it fails
  receipt.amount = 999_999_999;
  const isTamperedValid = await verifyReceipt(receipt);
  expect(isTamperedValid).toBe(false);
});
```

---

## Changelog

| Date       | Change                                         |
| ---------- | ---------------------------------------------- |
| 2026-07-24 | Added `On-Chain Donation Receipts` section with `generate_receipt` and `verify_receipt` functions and TypeScript examples |
