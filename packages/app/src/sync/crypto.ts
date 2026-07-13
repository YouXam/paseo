import { Buffer } from "buffer";

export const SYNC_KDF_ITERATIONS = 310_000;

export interface SyncKdfParams {
  name: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
}

export interface EncryptedSyncSnapshot {
  version: 1;
  algorithm: "AES-GCM";
  kdf: SyncKdfParams;
  nonceB64: string;
  ciphertextB64: string;
}

export interface DerivedSyncKeys {
  authVerifierB64: string;
  dataKey: CryptoKey;
}

const KDF_PARAMS: SyncKdfParams = {
  name: "PBKDF2",
  hash: "SHA-256",
  iterations: SYNC_KDF_ITERATIONS,
};
const BASE64_CHUNK_SIZE = 0x8000;

function requireSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Cloud sync requires Web Crypto support in this runtime.");
  }
  return subtle;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return decodeBase64(padded);
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    return btoa(bytesToBinaryString(bytes));
  }
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    return binaryStringToBytes(atob(value));
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK_SIZE));
  }
  return binary;
}

function binaryStringToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function importPassword(password: string): Promise<CryptoKey> {
  return await requireSubtleCrypto().importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );
}

export async function deriveSyncKeys(input: {
  password: string;
  authSaltB64: string;
  dataSaltB64: string;
}): Promise<DerivedSyncKeys> {
  if (!input.password) {
    throw new Error("Password is required.");
  }
  const subtle = requireSubtleCrypto();
  const passwordKey = await importPassword(input.password);
  const authSalt = base64UrlDecode(input.authSaltB64);
  const dataSalt = base64UrlDecode(input.dataSaltB64);

  const authBits = await subtle.deriveBits(
    {
      name: KDF_PARAMS.name,
      hash: KDF_PARAMS.hash,
      salt: toArrayBuffer(authSalt),
      iterations: KDF_PARAMS.iterations,
    },
    passwordKey,
    256,
  );

  const dataKey = await subtle.deriveKey(
    {
      name: KDF_PARAMS.name,
      hash: KDF_PARAMS.hash,
      salt: toArrayBuffer(dataSalt),
      iterations: KDF_PARAMS.iterations,
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );

  return {
    authVerifierB64: base64UrlEncode(new Uint8Array(authBits)),
    dataKey,
  };
}

export async function exportSyncDataKey(dataKey: CryptoKey): Promise<string> {
  const raw = await requireSubtleCrypto().exportKey("raw", dataKey);
  return base64UrlEncode(new Uint8Array(raw));
}

export async function importSyncDataKey(dataKeyB64: string): Promise<CryptoKey> {
  const raw = base64UrlDecode(dataKeyB64);
  return await requireSubtleCrypto().importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export function createSyncSalts(): { authSaltB64: string; dataSaltB64: string } {
  return {
    authSaltB64: randomBase64Url(16),
    dataSaltB64: randomBase64Url(16),
  };
}

export async function encryptSyncPayload(
  dataKey: CryptoKey,
  payload: unknown,
): Promise<EncryptedSyncSnapshot> {
  const subtle = requireSubtleCrypto();
  const nonce = new Uint8Array(12);
  globalThis.crypto.getRandomValues(nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    dataKey,
    plaintext,
  );
  return {
    version: 1,
    algorithm: "AES-GCM",
    kdf: KDF_PARAMS,
    nonceB64: base64UrlEncode(nonce),
    ciphertextB64: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

export async function decryptSyncPayload<T>(
  dataKey: CryptoKey,
  snapshot: EncryptedSyncSnapshot,
): Promise<T> {
  if (snapshot.version !== 1 || snapshot.algorithm !== "AES-GCM") {
    throw new Error("Unsupported encrypted sync snapshot.");
  }
  const subtle = requireSubtleCrypto();
  const nonce = base64UrlDecode(snapshot.nonceB64);
  const ciphertext = base64UrlDecode(snapshot.ciphertextB64);
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    dataKey,
    toArrayBuffer(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
