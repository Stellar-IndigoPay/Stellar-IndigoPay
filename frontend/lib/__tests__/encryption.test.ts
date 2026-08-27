import { encryptMessage, decryptMessage } from '../encryption';
import { Keypair } from '@stellar/stellar-sdk';

describe('Encryption', () => {
  it('should round-trip encrypt and decrypt a message', () => {
    const keypair = Keypair.random();
    const message = 'Hello, world!';
    const encrypted = encryptMessage(message, keypair.publicKey());
    const decrypted = decryptMessage(encrypted, keypair.secret());
    expect(decrypted).toBe(message);
  });
  
  it('plaintext-compatibility', () => {
    const keypair = Keypair.random();
    const encrypted = encryptMessage('Test', keypair.publicKey());
    expect(encrypted).not.toContain('Test');
  });
});
