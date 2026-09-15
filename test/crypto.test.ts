import { it, expect } from "vitest";
import {
  encryptOriginal,
  decryptOriginal,
  type KeyWrapper,
} from "../src/common/crypto.js";
// Test-only wrapper. Production must supply a real KMS adapter.
const kms: KeyWrapper = {
  async wrap(key) {
    return { wrappedKey: Buffer.from(key), keyRef: "test-only" };
  },
  async unwrap(key) {
    return Buffer.from(key);
  },
};
it("round-trips authenticated encryption and rejects tampering", async () => {
  const plain = Buffer.from("SYNTHETIC medical record");
  const encrypted = await encryptOriginal(plain, kms);
  expect(encrypted.ciphertext.equals(plain)).toBe(false);
  expect((await decryptOriginal(encrypted, kms)).equals(plain)).toBe(true);
  encrypted.ciphertext[0] ^= 1;
  await expect(decryptOriginal(encrypted, kms)).rejects.toThrow();
});
