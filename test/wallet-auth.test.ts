import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { WalletAuth, type WalletChallenge } from "../src/common/wallet-auth.js";
function setup() {
  const rows = new Map<string, WalletChallenge>();
  let time = Date.parse("2026-09-12T12:00:00Z");
  return {
    service: new WalletAuth(
      {
        async put(c) {
          rows.set(c.id, c);
        },
        async take(id) {
          const c = rows.get(id);
          rows.delete(id);
          return c ?? null;
        },
      },
      "http://localhost:3000",
      () => time,
    ),
    expire() {
      time += 300000;
    },
  };
}
function sign(key: Keypair, message: string) {
  return Buffer.from(
    key.sign(
      createHash("sha256")
        .update("Stellar Signed Message:\n" + message)
        .digest(),
    ),
  ).toString("base64");
}
it("verifies the exact SEP-53 message and prevents replay", async () => {
  const { service } = setup();
  const key = Keypair.random();
  const c = await service.challenge(key.publicKey());
  const signature = sign(key, c.message);
  await expect(
    service.verify(c.id, key.publicKey(), signature),
  ).resolves.toEqual({ address: key.publicKey() });
  await expect(
    service.verify(c.id, key.publicKey(), signature),
  ).rejects.toThrow("INVALID_CHALLENGE");
});
it("rejects expired, wrong-wallet and altered-message signatures", async () => {
  const { service, expire } = setup();
  const key = Keypair.random();
  const c = await service.challenge(key.publicKey());
  await expect(
    service.verify(c.id, key.publicKey(), sign(key, c.message + "altered")),
  ).rejects.toThrow("INVALID_SIGNATURE");
  const c2 = await service.challenge(key.publicKey());
  await expect(
    service.verify(c2.id, Keypair.random().publicKey(), sign(key, c2.message)),
  ).rejects.toThrow("INVALID_CHALLENGE");
  const c3 = await service.challenge(key.publicKey());
  expire();
  await expect(
    service.verify(c3.id, key.publicKey(), sign(key, c3.message)),
  ).rejects.toThrow("INVALID_CHALLENGE");
});
