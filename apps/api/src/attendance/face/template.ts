import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('Face template key must be 32 bytes');
}

/** Encrypts an embedding as AES-256-GCM: iv(12) | tag(16) | ciphertext (Float32 little-endian). */
export function encryptTemplate(embedding: number[], key: Buffer): Buffer {
  checkKey(key);
  const plain = Buffer.alloc(embedding.length * 4);
  embedding.forEach((v, i) => plain.writeFloatLE(v, i * 4));
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Decrypts a blob from `encryptTemplate`; throws if the key is wrong or the blob was altered. */
export function decryptTemplate(blob: Buffer, key: Buffer): number[] {
  checkKey(key);
  if (blob.length < IV_BYTES + TAG_BYTES || (blob.length - IV_BYTES - TAG_BYTES) % 4 !== 0) {
    throw new Error('Malformed face template');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
  const out: number[] = [];
  for (let i = 0; i < plain.length; i += 4) out.push(plain.readFloatLE(i));
  return out;
}

/** Element-wise mean of equal-length embeddings, then L2-normalised. */
export function averageEmbedding(list: number[][]): number[] {
  const first = list[0];
  if (!first || first.length === 0) throw new Error('No embeddings to average');
  if (list.some((e) => e.length !== first.length)) throw new Error('Embedding lengths differ');
  const mean = first.map((_, i) => list.reduce((s, e) => s + e[i]!, 0) / list.length);
  const norm = Math.sqrt(mean.reduce((s, v) => s + v * v, 0));
  if (norm === 0) throw new Error('Embeddings average to zero');
  return mean.map((v) => v / norm);
}
