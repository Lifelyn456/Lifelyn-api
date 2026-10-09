import { readFileSync } from "node:fs";
import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import type { ContractRole } from "./contracts.js";

export type SignerConfig = {
  /** Canonical network name: "testnet", "mainnet" or "local". */
  network: "testnet" | "mainnet" | "local";
  passphrase: string;
  rpcUrl: string;
  allowHttp: boolean;
  authToken: string;
  keypair: Keypair;
  /** contractId -> role. Only these contracts can ever be called. */
  contracts: ReadonlyMap<string, ContractRole>;
  /** How long a submit waits for a ledger result before answering PENDING. */
  confirmWaitMs: number;
  host: string;
  port: number;
  /** Optional JSON-lines file that keeps idempotency records across restarts. */
  stateFile?: string;
};

const NETWORKS = {
  testnet: { name: "testnet", passphrase: Networks.TESTNET },
  mainnet: { name: "mainnet", passphrase: Networks.PUBLIC },
  public: { name: "mainnet", passphrase: Networks.PUBLIC },
  local: { name: "local", passphrase: Networks.STANDALONE },
  standalone: { name: "local", passphrase: Networks.STANDALONE },
} as const;

/** Maps a network name from a request or from configuration to its canonical name, or undefined. */
export function canonicalNetwork(name: string | undefined) {
  const key = name?.toLowerCase();
  return key && Object.hasOwn(NETWORKS, key) ? NETWORKS[key as keyof typeof NETWORKS] : undefined;
}

const CONTRACT_ENV: Record<ContractRole, string> = {
  consent: "STELLAR_CONSENT_CONTRACT_ID",
  provider: "STELLAR_PROVIDER_CONTRACT_ID",
  attestation: "STELLAR_RECORD_ATTESTATION_CONTRACT_ID",
  receipt: "STELLAR_ACCESS_RECEIPT_CONTRACT_ID",
};

function readSecret(env: NodeJS.ProcessEnv, production: boolean) {
  const file = env.STELLAR_SIGNER_SECRET_FILE?.trim();
  const inline = env.STELLAR_SIGNER_SECRET?.trim();
  if (file && inline) throw new Error("Set only one of STELLAR_SIGNER_SECRET_FILE and STELLAR_SIGNER_SECRET.");
  if (production && inline) throw new Error("Production requires STELLAR_SIGNER_SECRET_FILE (a mounted secret), never an inline STELLAR_SIGNER_SECRET.");
  const secret = file ? readFileSync(file, "utf8").trim() : inline;
  if (!secret) throw new Error("A signing key is required: set STELLAR_SIGNER_SECRET_FILE (preferred) or, for development, STELLAR_SIGNER_SECRET.");
  if (!StrKey.isValidEd25519SecretSeed(secret)) throw new Error("The signing key is not a valid Stellar secret seed.");
  return secret;
}

/**
 * Reads and validates the signer's configuration. Throws with an explanatory message and never
 * includes a secret value in it.
 */
export function loadSignerConfig(env: NodeJS.ProcessEnv = process.env): SignerConfig {
  const production = env.NODE_ENV === "production";
  const network = canonicalNetwork(env.STELLAR_NETWORK);
  if (!network) throw new Error("STELLAR_NETWORK must be testnet, mainnet or local.");
  if (production && network.name === "local") throw new Error("Production cannot use the local network.");

  const rpcUrl = env.STELLAR_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("STELLAR_RPC_URL is required.");
  const rpc = new URL(rpcUrl);
  const allowHttp = rpc.protocol === "http:";
  if (allowHttp && (production || network.name !== "local")) throw new Error("STELLAR_RPC_URL must use HTTPS except on the local network.");

  const authToken = env.SIGNER_AUTH_TOKEN ?? "";
  if (Buffer.byteLength(authToken) < 32) throw new Error("SIGNER_AUTH_TOKEN must contain at least 32 bytes.");

  const contracts = new Map<string, ContractRole>();
  for (const [role, name] of Object.entries(CONTRACT_ENV) as [ContractRole, string][]) {
    const id = env[name]?.trim();
    if (!id) continue;
    if (!StrKey.isValidContract(id)) throw new Error(`${name} is not a valid contract ID.`);
    if (contracts.has(id)) throw new Error(`${name} duplicates another configured contract.`);
    contracts.set(id, role);
  }
  if (contracts.size === 0) throw new Error("Configure at least one STELLAR_*_CONTRACT_ID.");

  const port = Number(env.SIGNER_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SIGNER_PORT is invalid.");
  const confirmWaitMs = Number(env.SIGNER_CONFIRM_WAIT_MS ?? 10_000);
  if (!Number.isFinite(confirmWaitMs) || confirmWaitMs < 0 || confirmWaitMs > 50_000) throw new Error("SIGNER_CONFIRM_WAIT_MS must be between 0 and 50000.");

  return {
    network: network.name,
    passphrase: network.passphrase,
    rpcUrl,
    allowHttp,
    authToken,
    keypair: Keypair.fromSecret(readSecret(env, production)),
    contracts,
    confirmWaitMs,
    host: env.SIGNER_HOST ?? "127.0.0.1",
    port,
    stateFile: env.SIGNER_STATE_FILE?.trim() || undefined,
  };
}
