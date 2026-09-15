import { Injectable, ServiceUnavailableException } from "@nestjs/common";

type Operation = { contractId: string; method: string; args: Record<string, string | number> };

@Injectable()
export class StellarAdapter {
  private async submit(operation: Operation, idempotencyKey: string) {
    const endpoint = process.env.STELLAR_SIGNER_SERVICE_URL;
    const token = process.env.STELLAR_SIGNER_SERVICE_TOKEN;
    if (!endpoint || !token) throw new ServiceUnavailableException("Secure Stellar signing is not configured.");
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey }, body: JSON.stringify({ network: process.env.STELLAR_NETWORK ?? "testnet", rpcUrl: process.env.STELLAR_RPC_URL, ...operation }), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new ServiceUnavailableException("Stellar signer rejected the contract operation.");
    const result = await response.json() as { txHash?: string; status?: string };
    if (!result.txHash) throw new ServiceUnavailableException("Stellar signer did not return a transaction hash.");
    return { txHash: result.txHash, status: result.status ?? "PENDING" };
  }
  async confirm(txHash: string) {
    const endpoint = process.env.STELLAR_SIGNER_SERVICE_URL;
    const token = process.env.STELLAR_SIGNER_SERVICE_TOKEN;
    if (!endpoint || !token || !/^[a-fA-F0-9]{64}$/.test(txHash)) throw new ServiceUnavailableException("Stellar confirmation is not configured correctly.");
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/transactions/${txHash}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ServiceUnavailableException("Stellar transaction confirmation is unavailable.");
    const result = await response.json() as { status?: string };
    if (!result.status || !["PENDING", "SUCCESS", "FAILED"].includes(result.status)) throw new ServiceUnavailableException("Stellar confirmation returned an invalid status.");
    return result.status as "PENDING" | "SUCCESS" | "FAILED";
  }
  grant(input: { grantRef: string; subjectRef: string; recipient: string; scopeHash: string; startsAt: number; expiresAt: number }, idempotencyKey: string) {
    const contractId = process.env.STELLAR_CONSENT_CONTRACT_ID;
    if (!contractId || input.expiresAt <= input.startsAt) throw new ServiceUnavailableException("Consent contract is not configured correctly.");
    return this.submit({ contractId, method: "grant", args: input }, idempotencyKey);
  }
  revoke(grantRef: string, idempotencyKey: string) {
    const contractId = process.env.STELLAR_CONSENT_CONTRACT_ID;
    if (!contractId) throw new ServiceUnavailableException("Consent contract is not configured.");
    return this.submit({ contractId, method: "revoke", args: { grantRef } }, idempotencyKey);
  }
  attest(recordRef: string, contentHash: string, issuer: string, idempotencyKey: string) {
    const contractId = process.env.STELLAR_RECORD_ATTESTATION_CONTRACT_ID;
    if (!contractId) throw new ServiceUnavailableException("Record attestation contract is not configured.");
    return this.submit({ contractId, method: "attest", args: { recordRef, contentHash, issuer } }, idempotencyKey);
  }
  registerProvider(providerRef: string, metadataHash: string, idempotencyKey: string) {
    const contractId = process.env.STELLAR_PROVIDER_CONTRACT_ID;
    const authority = process.env.STELLAR_PROVIDER_AUTHORITY_ADDRESS;
    if (!contractId || !authority) throw new ServiceUnavailableException("Provider registry contract is not configured.");
    return this.submit({ contractId, method: "register", args: { providerRef, authority, metadataHash } }, idempotencyKey);
  }
  setProviderStatus(providerRef: string, verified: boolean, idempotencyKey: string) {
    const contractId = process.env.STELLAR_PROVIDER_CONTRACT_ID;
    if (!contractId) throw new ServiceUnavailableException("Provider registry contract is not configured.");
    return this.submit({ contractId, method: "set_status", args: { providerRef, verified: String(verified) } }, idempotencyKey);
  }
}
