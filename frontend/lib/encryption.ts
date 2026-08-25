import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import ed2curve from 'ed2curve';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * Encrypts a message for a given Stellar public key.
 * @param message The message to encrypt.
 * @param recipientPublicKey The Stellar public key (ed25519) to encrypt for.
 * @returns The base64 encoded ciphertext and ephemeral public key (nonce).
 */
export function encryptMessage(message: string, recipientPublicKey: string): string {
  // Convert recipient's ed25519 public key to curve25519
  const recipientKeypair = Keypair.fromPublicKey(recipientPublicKey);
  const recipientPublicKeyBytes = recipientKeypair.rawPublicKey();
  const recipientCurve25519Key = ed2curve.convertPublicKey(recipientPublicKeyBytes);
  
  if (!recipientCurve25519Key) {
    throw new Error('Failed to convert public key');
  }

  // Generate ephemeral keypair for sender
  const ephemeralKeypair = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  
  const messageBytes = naclUtil.decodeUTF8(message);
  
  const encrypted = nacl.box(
    messageBytes,
    nonce,
    recipientCurve25519Key,
    ephemeralKeypair.secretKey
  );

  // We need to return the nonce, the ephemeral public key, and the ciphertext
  // Let's pack them into a single base64 string
  // Format: Version(1) + Nonce(24) + EphemeralPubKey(32) + Ciphertext
  const payload = new Uint8Array(1 + nonce.length + ephemeralKeypair.publicKey.length + encrypted.length);
  payload[0] = 1; // Version
  payload.set(nonce, 1);
  payload.set(ephemeralKeypair.publicKey, 1 + nonce.length);
  payload.set(encrypted, 1 + nonce.length + ephemeralKeypair.publicKey.length);

  return naclUtil.encodeBase64(payload);
}
