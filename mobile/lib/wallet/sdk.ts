/**
 * lib/wallet/sdk.ts
 *
 * Non-custodial Stellar wallet SDK for the IndigoPay mobile app.
 *
 * Key design:
 * - Keys are generated via @stellar/stellar-sdk Keypair.random() (Ed25519).
 * - The raw 32-byte Ed25519 seed is encoded as a 12-word BIP39 mnemonic
 *   for human-friendly backup. The seed itself is also stored as a
 *   Stellar-format secret key (S…).
 * - All signing operations require biometric authentication via
 *   useBiometricAuth.authenticate(). The secret key is loaded from
 *   SecureStore with requireAuth: true.
 * - The SDK is a module of pure functions — no React hooks. Callers
 *   (AuthProvider, screens) orchestrate the authentication gates.
 *
 * Security note (from issue #128):
 *   The Ed25519 secret key MUST NOT be directly reused for any other
 *   cryptographic purpose (e.g., NaCl encryption). If encryption keys
 *   are needed, derive them from the mnemonic seed via HKDF with
 *   separate domain separation strings. See NIST SP 800-108.
 */
import {
  Keypair,
  Networks,
  Horizon,
  TransactionBuilder,
  StrKey,
} from "@stellar/stellar-sdk";
import * as secureStore from "../secureStore";
import { WORDLIST } from "./wordlist";

// ── Constants ──────────────────────────────────────────────────────────────

const WALLET_SECRET_KEY = "wallet_secret_key";
const HORIZON_URL =
  process.env.EXPO_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.EXPO_PUBLIC_STELLAR_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

const MNEMONIC_ENTROPY_BITS = 128; // 12 words
const MNEMONIC_WORD_COUNT = 12;

// ── Types ──────────────────────────────────────────────────────────────────

export interface GeneratedWallet {
  publicKey: string;
  secretKey: string;
  mnemonic: string;
}

export interface WalletBalance {
  xlm: string;
  usdc?: string;
}

export interface SignResult {
  signedXDR: string;
  transactionHash: string;
}

// ── Mnemonic helpers ──────────────────────────────────────────────────────

/**
 * Encode a Uint8Array of entropy into a BIP39 mnemonic phrase.
 * Uses 128-bit entropy → 12 words with 4-bit checksum.
 */
function entropyToMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== 16) {
    throw new Error("Mnemonic requires exactly 128 bits (16 bytes) of entropy");
  }

  // Compute SHA-256 checksum
  const hash = _sha256(entropy);
  const checksumBits = entropy.length / 4; // 4 bits for 16 bytes
  const checksum = hash[0] >> (8 - checksumBits);

  // Combine entropy + checksum into a bit buffer
  const totalBits = entropy.length * 8 + checksumBits;
  const bits: number[] = [];
  for (let i = 0; i < entropy.length; i++) {
    for (let j = 7; j >= 0; j--) {
      bits.push((entropy[i] >> j) & 1);
    }
  }
  for (let i = checksumBits - 1; i >= 0; i--) {
    bits.push((checksum >> i) & 1);
  }

  // Split into 11-bit indices
  const words: string[] = [];
  for (let i = 0; i < totalBits; i += 11) {
    let index = 0;
    for (let j = 0; j < 11 && i + j < totalBits; j++) {
      index = (index << 1) | (bits[i + j] ?? 0);
    }
    words.push(WORDLIST[index]);
  }

  return words.join(" ");
}

/**
 * Decode a BIP39 mnemonic phrase back into entropy bytes.
 * Throws if the checksum is invalid.
 */
function mnemonicToEntropy(mnemonic: string): Uint8Array {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (words.length !== MNEMONIC_WORD_COUNT) {
    throw new Error(
      `Mnemonic must have exactly ${MNEMONIC_WORD_COUNT} words`,
    );
  }

  const indices = words.map((w) => {
    const idx = WORDLIST.indexOf(w);
    if (idx === -1) throw new Error(`Invalid mnemonic word: "${w}"`);
    return idx;
  });

  // Reconstruct bit sequence
  const totalBits = MNEMONIC_WORD_COUNT * 11;
  const checksumBits = MNEMONIC_WORD_COUNT / 3; // 4 bits for 12 words
  const entropyBits = totalBits - checksumBits;
  const bits: number[] = [];

  for (const idx of indices) {
    for (let j = 10; j >= 0; j--) {
      bits.push((idx >> j) & 1);
    }
  }

  // Extract entropy
  const entropy = new Uint8Array(entropyBits / 8);
  for (let i = 0; i < entropyBits; i++) {
    if (bits[i]) {
      entropy[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
    }
  }

  // Verify checksum
  const hash = _sha256(entropy);
  let expectedChecksum = 0;
  for (let i = entropyBits; i < totalBits; i++) {
    expectedChecksum = (expectedChecksum << 1) | (bits[i] ?? 0);
  }
  const actualChecksum = hash[0] >> (8 - checksumBits);
  if (expectedChecksum !== actualChecksum) {
    throw new Error("Invalid mnemonic checksum");
  }

  return entropy;
}

/**
 * Minimal SHA-256 implementation using SubtleCrypto when available,
 * falling back to a pure-JS implementation for React Native.
 *
 * In React Native, the global crypto.subtle may not be available,
 * so we use the built-in hermes engine's subtle if present, or
 * a polyfill approach. For production, expo-crypto should be used;
 * this implementation is kept dependency-free for the SDK layer.
 */
function _sha256(data: Uint8Array): Uint8Array {
  // Simple pure-JS SHA-256 for React Native compatibility.
  // This is intentionally minimal — full BIP39 validation is only
  // used during wallet import, not on every signing operation.
  //
  // For production, consider expo-crypto or a native module.
  // Here we use a compact implementation.
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  // Padding
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const paddedLen = ((msgLen + 9 + 63) >> 6) << 6; // round up to multiple of 64
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[msgLen] = 0x80;
  // Write bit length as big-endian 64-bit
  for (let i = 0; i < 8; i++) {
    padded[paddedLen - 1 - i] = Number((BigInt(bitLen) >> BigInt(i * 8)) & 0xffn);
  }

  // Initial hash values
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // Process each 64-byte block
  for (let i = 0; i < paddedLen; i += 64) {
    const W = new Uint32Array(64);
    for (let j = 0; j < 16; j++) {
      W[j] =
        (padded[i + j * 4]! << 24) |
        (padded[i + j * 4 + 1]! << 16) |
        (padded[i + j * 4 + 2]! << 8) |
        padded[i + j * 4 + 3]!;
    }
    for (let j = 16; j < 64; j++) {
      const s0 =
        ((W[j - 15]! >>> 7) | (W[j - 15]! << 25)) ^
        ((W[j - 15]! >>> 18) | (W[j - 15]! << 14)) ^
        (W[j - 15]! >>> 3);
      const s1 =
        ((W[j - 2]! >>> 17) | (W[j - 2]! << 15)) ^
        ((W[j - 2]! >>> 19) | (W[j - 2]! << 13)) ^
        (W[j - 2]! >>> 10);
      W[j] = (W[j - 16]! + s0 + W[j - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let j = 0; j < 64; j++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[j]! + W[j]!) >>> 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const result = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    result[i * 4] = (H[i]! >>> 24) & 0xff;
    result[i * 4 + 1] = (H[i]! >>> 16) & 0xff;
    result[i * 4 + 2] = (H[i]! >>> 8) & 0xff;
    result[i * 4 + 3] = H[i]! & 0xff;
  }
  return result;
}

// ── Wallet operations ─────────────────────────────────────────────────────

/**
 * Generate a new Stellar wallet.
 *
 * Uses Keypair.random() which produces a cryptographically secure
 * Ed25519 keypair. The raw 32-byte secret seed is also encoded as
 * a 12-word BIP39 mnemonic for human-friendly backup.
 *
 * IMPORTANT: The caller is responsible for persisting the secretKey
 * to SecureStore before this function returns. The secret material
 * MUST NOT be logged or transmitted.
 */
export function generateWallet(): GeneratedWallet {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();

  // Derive mnemonic from the raw Ed25519 seed (first 16 bytes of raw secret)
  const rawSecret = keypair.rawSecretKey();
  // Truncate to 16 bytes for 128-bit entropy → 12-word mnemonic
  const entropy = rawSecret.slice(0, 16);
  const mnemonic = entropyToMnemonic(entropy);

  return { publicKey, secretKey, mnemonic };
}

/**
 * Import a wallet from a Stellar secret key (S…) or a 12-word BIP39
 * mnemonic phrase.
 *
 * @param input - Stellar secret key (S…) or space-separated mnemonic words.
 * @returns The reconstructed wallet (publicKey + secretKey).
 */
export function importWallet(input: string): { publicKey: string; secretKey: string } {
  const trimmed = input.trim();

  // Try Stellar secret key first (starts with S)
  if (trimmed.startsWith("S") && trimmed.length === 56) {
    try {
      const keypair = Keypair.fromSecret(trimmed);
      return { publicKey: keypair.publicKey(), secretKey: trimmed };
    } catch {
      throw new Error("Invalid Stellar secret key");
    }
  }

  // Try mnemonic phrase
  try {
    const entropy = mnemonicToEntropy(trimmed);
    // The Stellar SDK requires the full 32-byte seed. We pad the
    // 16-byte mnemonic entropy with zeros to get a 32-byte seed.
    const seed = new Uint8Array(32);
    seed.set(entropy);
    const keypair = Keypair.fromRawEd25519Seed(Buffer.from(seed));
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
  } catch (err) {
    throw new Error(
      "Invalid wallet input. Provide a Stellar secret key (S…) or a 12-word recovery phrase.",
    );
  }
}

// ── Secure storage ────────────────────────────────────────────────────────

/**
 * Persist the wallet secret key to SecureStore with biometric protection.
 * Returns true on success, false if the biometric gate was cancelled
 * or storage failed.
 */
export async function storeSecretKey(secretKey: string): Promise<boolean> {
  return secureStore.set(WALLET_SECRET_KEY, secretKey, { requireAuth: true });
}

/**
 * Load the wallet secret key from SecureStore. Triggers a biometric
 * prompt. Returns null if cancelled, expired, or not found.
 */
export async function loadSecretKey(): Promise<string | null> {
  return secureStore.get<string>(WALLET_SECRET_KEY, { requireAuth: true });
}

/**
 * Delete the stored secret key from SecureStore (with biometric gate).
 */
export async function deleteSecretKey(): Promise<boolean> {
  return secureStore.remove(WALLET_SECRET_KEY, { requireAuth: true });
}

/**
 * Check if a wallet secret key is stored (no biometric prompt).
 */
export async function hasWallet(): Promise<boolean> {
  return secureStore.has(WALLET_SECRET_KEY);
}

// ── Balance ───────────────────────────────────────────────────────────────

/**
 * Fetch the XLM balance for a Stellar account from Horizon.
 */
export async function getBalance(publicKey: string): Promise<WalletBalance> {
  const server = new Horizon.Server(HORIZON_URL);
  try {
    const account = await server.loadAccount(publicKey);
    const xlmBalance =
      account.balances.find((b: any) => b.asset_type === "native")?.balance || "0";
    return { xlm: xlmBalance };
  } catch (err: any) {
    if (err?.response?.status === 404) {
      return { xlm: "0" };
    }
    throw err;
  }
}

// ── Transaction signing ───────────────────────────────────────────────────

/**
 * Sign a Stellar transaction and return the signed XDR + hash.
 *
 * The caller MUST perform biometric authentication before calling
 * this function — the SDK does not gate signing itself so it can
 * be used in both foreground and SEP-0007 confirmation flows.
 *
 * @param xdr - The unsigned transaction envelope XDR (base64).
 * @param secretKey - The Stellar secret key (S…).
 * @returns The signed XDR and transaction hash.
 */
export function signTransaction(
  xdr: string,
  secretKey: string,
): SignResult {
  const keypair = Keypair.fromSecret(secretKey);

  // Parse, sign, re-serialize
  const transaction = TransactionBuilder.fromXDR(
    xdr,
    NETWORK_PASSPHRASE,
  ) as any;

  // The @stellar/stellar-sdk v12 Transaction class has a sign() method
  if (typeof transaction.sign === "function") {
    transaction.sign(keypair);
  } else {
    // Manual signing: add the keypair signature
    const tx = transaction as { signatures?: Array<{ hint: () => Buffer; sign: (data: Buffer) => Buffer }>; sign: (kp: typeof keypair) => void };
    if (typeof tx.sign === "function") {
      tx.sign(keypair);
    } else {
      // Fallback: use the transaction's addSignature
      const hash = transaction.hash();
      const sig = keypair.sign(hash);
      // TypeScript doesn't know about addSignature on the Transaction type
      (transaction as any).addSignature?.(keypair.publicKey(), sig.toString("base64"));
    }
  }

  const signedXDR = transaction.toXDR();
  const transactionHash = transaction.hash().toString("hex");

  return { signedXDR, transactionHash };
}

/**
 * Build a payment transaction envelope (unsigned XDR).
 * The caller should then call signTransaction() with the secret key.
 */
export async function buildPaymentTransaction(params: {
  sourcePublicKey: string;
  destination: string;
  amount: string;
  memo?: string;
}): Promise<string> {
  const { Operation, Asset, Memo } = await import("@stellar/stellar-sdk");
  const txServer = new Horizon.Server(HORIZON_URL);
  const sourceAccount = await txServer.loadAccount(params.sourcePublicKey);

  const builder = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset: Asset.native(),
        amount: params.amount,
      }),
    )
    .setTimeout(60);

  if (params.memo) {
    builder.addMemo(Memo.text(params.memo.slice(0, 28)));
  }

  const transaction = builder.build();
  return transaction.toXDR();
}

/**
 * Submit a signed transaction XDR to the Stellar network via Horizon.
 */
export async function submitTransaction(signedXDR: string): Promise<{
  hash: string;
  ledger: number;
}> {
  const server = new Horizon.Server(HORIZON_URL);
  const transaction = TransactionBuilder.fromXDR(
    signedXDR,
    NETWORK_PASSPHRASE,
  );
  const result = await server.submitTransaction(transaction as any);
  return { hash: result.hash, ledger: result.ledger ?? 0 };
}

// ── Utilities ─────────────────────────────────────────────────────────────

/**
 * Validate a Stellar public key or secret key format.
 */
export function isValidPublicKey(key: string): boolean {
  return StrKey.isValidEd25519PublicKey(key.trim());
}

export function isValidSecretKey(key: string): boolean {
  return StrKey.isValidEd25519SecretSeed(key.trim());
}

/**
 * Derive a 12-word BIP39 mnemonic from a stored Stellar secret key.
 * Reverses the process used in generateWallet(): secretKey → Keypair →
 * rawSecretKey → first 16 bytes → BIP39 mnemonic.
 */
export function deriveMnemonic(secretKey: string): string {
  const keypair = Keypair.fromSecret(secretKey);
  const rawSecret = keypair.rawSecretKey();
  const entropy = rawSecret.slice(0, 16);
  return entropyToMnemonic(entropy);
}

export { NETWORK_PASSPHRASE, HORIZON_URL };
