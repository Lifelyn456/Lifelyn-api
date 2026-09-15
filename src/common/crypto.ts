import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export interface KeyWrapper {
  wrap(key: Buffer): Promise<{ wrappedKey: Buffer; keyRef: string }>;
  unwrap(wrappedKey: Buffer, keyRef: string): Promise<Buffer>;
}
export async function encryptOriginal(plaintext: Buffer, kms: KeyWrapper) {
  const key = randomBytes(32),
    iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      ciphertext,
      iv,
      tag: cipher.getAuthTag(),
      sha256: createHash("sha256").update(plaintext).digest("hex"),
      ...(await kms.wrap(key)),
    };
  } finally {
    key.fill(0);
  }
}
export async function decryptOriginal(
  record: {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
    wrappedKey: Buffer;
    keyRef: string;
    sha256: string;
  },
  kms: KeyWrapper,
) {
  const key = await kms.unwrap(record.wrappedKey, record.keyRef);
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, record.iv);
    cipher.setAuthTag(record.tag);
    const plaintext = Buffer.concat([
      cipher.update(record.ciphertext),
      cipher.final(),
    ]);
    const actual = createHash("sha256").update(plaintext).digest();
    const expected = Buffer.from(record.sha256, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected))
      throw new Error("INTEGRITY_MISMATCH");
    return plaintext;
  } finally {
    key.fill(0);
  }
}
