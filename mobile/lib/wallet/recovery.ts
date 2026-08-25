import secrets from 'secrets.js-grempe';
import * as SecureStore from '../secureStore';
import { Buffer } from 'buffer';
import { Keypair } from "@stellar/stellar-sdk";

// Helper to convert string to hex and back
function str2hex(str: string): string {
  return Buffer.from(str, 'utf8').toString('hex');
}

function hex2str(hex: string): string {
  return Buffer.from(hex, 'hex').toString('utf8');
}

export interface SplitResult {
  secureStoreShare: string;
  cloudShare: string;
  emailShare: string;
}

export async function splitKeyAndStore(secretKey: string): Promise<SplitResult> {
  const hexKey = str2hex(secretKey);
  const shares = secrets.share(hexKey, 5, 3);
  
  const result: SplitResult = {
    secureStoreShare: shares[0],
    cloudShare: shares[1],
    emailShare: shares[2],
  };

  await SecureStore.set('wallet_share_1', result.secureStoreShare, { requireAuth: true });
  
  const pubKey = Keypair.fromSecret(secretKey).publicKey();
  await SecureStore.set('wallet_pubkey', pubKey, { requireAuth: false });
  
  return result;
}

export async function recoverKey(shares: string[]): Promise<string> {
  if (shares.length < 3) {
    throw new Error('Not enough shares to recover the key (minimum 3 required).');
  }
  
  // Need biometric auth to recover
  const share1 = await SecureStore.get<string>('wallet_share_1', { requireAuth: true });
  const allShares = [...shares];
  if (share1 && !allShares.includes(share1)) {
    allShares.push(share1);
  }
  
  if (allShares.length < 3) {
    throw new Error('Not enough shares even with SecureStore share.');
  }

  const hexRecovered = secrets.combine(allShares.slice(0, 3));
  const secretKey = hex2str(hexRecovered);
  return secretKey;
}

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
