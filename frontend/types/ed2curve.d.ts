declare module 'ed2curve' {
  export function convertPublicKey(publicKey: Uint8Array): Uint8Array | null;
  export function convertSecretKey(secretKey: Uint8Array): Uint8Array;
}
