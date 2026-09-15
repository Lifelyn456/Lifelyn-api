import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
export type WalletChallenge = {
  id: string;
  message: string;
  address: string;
  origin: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};
export interface ChallengeStore {
  put(challenge: WalletChallenge, ttlSeconds: number): Promise<void>;
  take(id: string): Promise<WalletChallenge | null>;
}
export function challengeMessage(c: Omit<WalletChallenge, "message">) {
  return `Sign in to Lifelyn\n\nOrigin: ${c.origin}\nWallet: ${c.address}\nChallenge: ${c.id}\nNonce: ${c.nonce}\nIssued: ${c.issuedAt}\nExpires: ${c.expiresAt}\n\nThis proves wallet ownership only. It does not authorize a payment or grant access to medical records.`;
}
export class WalletAuth {
  constructor(
    private readonly store: ChallengeStore,
    private readonly origin: string,
    private readonly clock: () => number = Date.now,
  ) {}
  async challenge(address: string) {
    if (!StrKey.isValidEd25519PublicKey(address))
      throw new Error("INVALID_WALLET");
    const now = this.clock();
    const fields = {
      id: randomUUID(),
      address,
      origin: this.origin,
      nonce: randomBytes(32).toString("hex"),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300000).toISOString(),
    };
    const challenge = { ...fields, message: challengeMessage(fields) };
    await this.store.put(challenge, 300);
    return challenge;
  }
  async verify(id: string, address: string, signature: string) {
    const challenge = await this.store.take(id);
    if (
      !challenge ||
      challenge.address !== address ||
      challenge.origin !== this.origin ||
      Date.parse(challenge.expiresAt) <= this.clock() ||
      challenge.message !== challengeMessage(challenge)
    )
      throw new Error("INVALID_CHALLENGE");
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature))
      throw new Error("INVALID_SIGNATURE");
    const bytes = Buffer.from(signature, "base64");
    const hash = createHash("sha256")
      .update("Stellar Signed Message:\n", "utf8")
      .update(challenge.message, "utf8")
      .digest();
    if (!Keypair.fromPublicKey(address).verify(hash, bytes))
      throw new Error("INVALID_SIGNATURE");
    return { address };
  }
}
