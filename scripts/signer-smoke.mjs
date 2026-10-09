// End-to-end check of the signer against a real network, driven through the API's own
// StellarAdapter so the request/response contract between the two is exercised exactly.
//
//   pnpm build && node dist/signer/main.js      # in one terminal, with the signer's env
//   node scripts/signer-smoke.mjs                # in another, with the API-side env below
//
// Required environment (the same names the API uses, plus the smoke test's own):
//   STELLAR_NETWORK, STELLAR_RPC_URL, STELLAR_CONSENT_CONTRACT_ID,
//   STELLAR_SIGNER_SERVICE_URL, STELLAR_SIGNER_SERVICE_TOKEN,
//   SMOKE_SIGNER_ADDRESS   the public address of the signer's key (used as the read-only simulation source)
//   SMOKE_RECIPIENT        any valid Stellar address to record as the consent recipient
// Everything it writes is synthetic and lives on the network you point it at.
import { randomBytes } from "node:crypto";
import { BASE_FEE, Contract, nativeToScVal, rpc, scValToNative, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { StellarAdapter } from "../dist/integrations/stellar.js";

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};

const rpcUrl = need("STELLAR_RPC_URL");
const consent = need("STELLAR_CONSENT_CONTRACT_ID");
const passphrase = { testnet: Networks.TESTNET, mainnet: Networks.PUBLIC, local: Networks.STANDALONE }[need("STELLAR_NETWORK")];
if (!passphrase) throw new Error("STELLAR_NETWORK must be testnet, mainnet or local.");
const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

async function isActive(grantRef) {
  const source = await server.getAccount(need("SMOKE_SIGNER_ADDRESS"));
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(consent).call("is_active", nativeToScVal(Buffer.from(grantRef, "hex"))))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation)) throw new Error("is_active simulation failed");
  return scValToNative(simulation.result.retval);
}

async function settle(adapter, result, label) {
  let status = result.status;
  for (let attempt = 0; status === "PENDING" && attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = await adapter.confirm(result.txHash);
  }
  if (status !== "SUCCESS") throw new Error(`${label} ended as ${status}`);
  console.log(`${label}: SUCCESS tx ${result.txHash}`);
}

const adapter = new StellarAdapter();
const grantRef = randomBytes(32).toString("hex");
const now = Math.floor(Date.now() / 1000);
const grant = { grantRef, subjectRef: randomBytes(32).toString("hex"), recipient: need("SMOKE_RECIPIENT"), scopeHash: randomBytes(32).toString("hex"), startsAt: now - 60, expiresAt: now + 3600 };
const grantKey = `smoke-grant-${grantRef.slice(0, 16)}`;

await settle(adapter, await adapter.grant(grant, grantKey), "grant");
if ((await isActive(grantRef)) !== true) throw new Error("grant is not active on-chain after confirmation");
console.log("on-chain is_active after grant: true");

const repeated = await adapter.grant(grant, grantKey);
console.log(`retry with the same idempotency key returned the same transaction: ${repeated.txHash === (await adapter.grant(grant, grantKey)).txHash}`);

await settle(adapter, await adapter.revoke(grantRef, `smoke-revoke-${grantRef.slice(0, 16)}`), "revoke");
if ((await isActive(grantRef)) !== false) throw new Error("grant is still active on-chain after revocation");
console.log("on-chain is_active after revoke: false");
console.log("Signer end-to-end check passed.");
