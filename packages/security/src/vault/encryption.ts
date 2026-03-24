import { createHash, randomBytes } from "node:crypto";

const textEncoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export interface EncryptedBlob {
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export interface DerivedKey {
  readonly key: CryptoKey;
  readonly salt: string;
}

export async function deriveKey(passphrase: string, salt: string): Promise<DerivedKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: textEncoder.encode(salt),
      iterations: 100_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  return { key, salt };
}

export function deriveSalt(passphrase: string): string {
  return createHash("sha256").update(passphrase).digest("hex").slice(0, 32);
}

export async function encryptValue(key: CryptoKey, plaintext: string): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const encoded = textEncoder.encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const encryptedBytes = new Uint8Array(encrypted);
  const tag = encryptedBytes.subarray(encryptedBytes.length - 16);
  const ciphertext = encryptedBytes.subarray(0, encryptedBytes.length - 16);

  return {
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    authTag: toBase64(tag),
  };
}

export async function decryptValue(key: CryptoKey, blob: EncryptedBlob): Promise<string> {
  const iv = fromBase64(blob.iv);
  const ciphertext = fromBase64(blob.ciphertext);
  const authTag = fromBase64(blob.authTag);
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new TextDecoder().decode(decrypted);
}

export function createPassphrase(defaultSeed: string): string {
  return defaultSeed;
}
