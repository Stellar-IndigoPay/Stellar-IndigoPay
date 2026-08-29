import { requireNativeModule } from 'expo-modules-core';
import { authenticate } from "../hooks/useBiometricAuth";
import { Keypair } from "@stellar/stellar-sdk";

// Require the native module we created in Swift/Kotlin
const StellarSigner = requireNativeModule('StellarSigner');

export async function generateKey(alias: string): Promise<string> {
  return await StellarSigner.generateKey(alias);
}

export async function importKey(alias: string, secretKey: string): Promise<string> {
  // If we really want to support importing keys to the Secure Enclave, we could add this to the native module.
  // For now we might just implement it on the native side if needed, or throw an error since hardware keys shouldn't be imported easily.
  // However, for compatibility we'll let it call a hypothetical native importKey or just throw.
  if (StellarSigner.importKey) {
    return await StellarSigner.importKey(alias, secretKey);
  }
  throw new Error("Hardware-backed keys cannot be imported from raw secrets in this implementation.");
}

export async function getPublicKey(alias: string): Promise<string | null> {
  return await StellarSigner.getPublicKey(alias);
}

export async function sign(alias: string, data: Buffer, reason: string = "Sign transaction"): Promise<Buffer> {
  // Biometric authentication can be handled by the native module (like iOS LAContext), 
  // but we can still call our React Native hook for UX if desired. 
  // The native module enforces it on the hardware level.
  const signatureBase64 = await StellarSigner.sign(alias, data.toString('base64'), reason);
  return Buffer.from(signatureBase64, 'base64');
}
