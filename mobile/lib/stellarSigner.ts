import { Keypair } from "@stellar/stellar-sdk";
import { authenticate } from "../hooks/useBiometricAuth";

// We mock the native module for testing, but in a real app this would be implemented natively.
// The real native module would store the key in the Secure Enclave/Keystore and perform the signing natively.
const mockKeystore = new Map<string, string>(); // alias -> secret key

export async function generateKey(alias: string): Promise<string> {
  const keypair = Keypair.random();
  mockKeystore.set(alias, keypair.secret());
  return keypair.publicKey();
}

export async function importKey(alias: string, secretKey: string): Promise<string> {
  const keypair = Keypair.fromSecret(secretKey);
  mockKeystore.set(alias, secretKey);
  return keypair.publicKey();
}

export async function getPublicKey(alias: string): Promise<string | null> {
  const secret = mockKeystore.get(alias);
  if (!secret) return null;
  return Keypair.fromSecret(secret).publicKey();
}

export async function sign(alias: string, data: Buffer, reason: string = "Sign transaction"): Promise<Buffer> {
  const authSuccess = await authenticate(reason);
  if (!authSuccess) {
    throw new Error("Biometric authentication failed");
  }

  const secret = mockKeystore.get(alias);
  if (!secret) {
    throw new Error("Key not found");
  }

  // The secret key never enters JS memory in the real native module, 
  // but for testing we mock it here using stellar-sdk.
  const keypair = Keypair.fromSecret(secret);
  return keypair.sign(data);
}
