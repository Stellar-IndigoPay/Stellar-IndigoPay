import secrets from 'secrets.js-grempe';
import * as SecureStore from '../secureStore';
import { Buffer } from 'buffer';
import { Keypair } from "@stellar/stellar-sdk";
import { deleteSecretKey } from './sdk';

// Helper to convert string to hex and back
/**
 * Helper to convert a UTF-8 string to a hex-encoded string.
 * @param str The input string.
 * @returns Hex-encoded string.
 */
function str2hex(str: string): string {
  return Buffer.from(str, 'utf8').toString('hex');
}

/**
 * Helper to convert a hex-encoded string back to a UTF-8 string.
 * @param hex The hex-encoded string.
 * @returns Decoded UTF-8 string.
 */
function hex2str(hex: string): string {
  return Buffer.from(hex, 'hex').toString('utf8');
}

export interface SplitResult {
  secureStoreShare: string;
  cloudShare: string;
  emailShare: string;
  manualShare1: string;
  manualShare2: string;
}

/**
 * Splits a Stellar secret key into 5 Shamir shares with a threshold of 3.
 * Share 1 is stored in SecureStore with biometric authentication enabled.
 * Shares 2 and 3 are returned for cloud and email backup, while shares 4 and 5 are manual backups.
 * The original secret key is deleted from memory upon success.
 * 
 * @param secretKey The Stellar secret key to split.
 * @returns SplitResult containing the generated shares.
 */
export async function splitKeyAndStore(secretKey: string): Promise<SplitResult> {
  // Biometric gating for splitting
  const auth = await SecureStore.get<string>('wallet_pubkey', { requireAuth: true });
  
  const hexKey = str2hex(secretKey);
  const shares = secrets.share(hexKey, 5, 3);
  
  const result: SplitResult = {
    secureStoreShare: shares[0],
    cloudShare: shares[1],
    emailShare: shares[2],
    manualShare1: shares[3],
    manualShare2: shares[4],
  };

  await SecureStore.set('wallet_share_1', result.secureStoreShare, { requireAuth: true });
  
  const pubKey = Keypair.fromSecret(secretKey).publicKey();
  await SecureStore.set('wallet_pubkey', pubKey, { requireAuth: false });

  // Original-key destruction
  await deleteSecretKey();
  
  return result;
}

/**
 * Reconstructs a Stellar secret key from a set of Shamir shares.
 * Automatically retrieves the biometric-protected Share 1 from SecureStore
 * and combines it with the provided external shares.
 * 
 * @param shares Array of external shares provided by the user.
 * @returns The reconstructed secret key.
 */
export async function recoverKey(shares: string[]): Promise<string> {
  // Biometric gating for recovery
  const share1 = await SecureStore.get<string>('wallet_share_1', { requireAuth: true });
  const allShares = [...shares];
  if (share1 && !allShares.includes(share1)) {
    allShares.push(share1);
  }
  
  if (allShares.length < 3) {
    throw new Error('Not enough shares to recover the key (minimum 3 required).');
  }

  const hexRecovered = secrets.combine(allShares.slice(0, 3));
  const secretKey = hex2str(hexRecovered);
  return secretKey;
}

/**
 * Verifies that a reconstructed secret key matches the stored public key.
 * 
 * @param secretKey The reconstructed secret key to verify.
 * @returns Promise resolving to boolean verification outcome.
 */
export async function verifyKey(secretKey: string): Promise<boolean> {
  try {
    const pubKey = Keypair.fromSecret(secretKey).publicKey();
    const storedPubKey = await SecureStore.get<string>('wallet_pubkey');
    if (storedPubKey) {
      return storedPubKey === pubKey;
    }
    return true; 
  } catch(e) {
    return false;
  }
}
