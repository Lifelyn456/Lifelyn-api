import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Account, Keypair, Networks } from "@stellar/stellar-sdk";
import { buildSignerServer } from "../src/signer/server.js";
import { loadSignerConfig, canonicalNetwork, type SignerConfig } from "../src/signer/config.js";
import { SignerService, type SignerRpc } from "../src/signer/service.js";

const CONSENT = "CCLKF6V5NV5KWIZMIYN4YSJXWCUK7PFYIRXSRVO7OM2AO2HDVCFXFCED";
const PROVIDER = "CBSULDGXAYGMMME5X47TIAJZ3IKTTRNR2Y4KSCZKKOPY4E37BY6IM57U";
const TOKEN = "s".repeat(40);
const signer = Keypair.random();
const hex = (digit: string) => digit.repeat(64);

function config(): SignerConfig {
  return {
    network: "testnet",
    passphrase: Networks.TESTNET,
    rpcUrl: "https://rpc.invalid",
    allowHttp: false,
    authToken: TOKEN,
    keypair: signer,
    contracts: new Map([[CONSENT, "consent" as const]]),
    confirmWaitMs: 0,
    host: "127.0.0.1",
    port: 0,
  };
}

function rpc() {
  const calls: string[] = [];
  const client: SignerRpc = {
    async getAccount(publicKey) {
      calls.push("getAccount");
      return new Account(publicKey, "100");
    },
    async prepareTransaction(tx) {
      calls.push("prepare");
      return tx;
    },
    async sendTransaction() {
      calls.push("send");
      return { status: "PENDING", hash: hex("b") };
    },
    async getTransaction() {
      calls.push("get");
      return { status: "SUCCESS" };
    },
  };
  return { client, calls };
}

async function server() {
  const fake = rpc();
  const app = await buildSignerServer(new SignerService(config(), fake.client, undefined, 1), TOKEN, { logger: false });
  return { app, calls: fake.calls };
}

const auth = { authorization: `Bearer ${TOKEN}` };
const revoke = { network: "testnet", rpcUrl: "https://attacker.invalid", contractId: CONSENT, method: "revoke", args: { grantRef: hex("1") } };

describe("signer HTTP server", () => {
  it("answers liveness without authentication and reveals nothing", async () => {
    const { app } = await server();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it.each([
    ["no credentials", {}],
    ["the wrong token", { authorization: "Bearer wrong" }],
    ["a token without the Bearer scheme", { authorization: TOKEN }],
    ["an empty bearer token", { authorization: "Bearer " }],
  ])("rejects %s on every other route and does not touch the network", async (_label, headers) => {
    const { app, calls } = await server();
    const post = await app.inject({ method: "POST", url: "/", headers: { ...headers, "idempotency-key": "grant:auth-00001" }, payload: revoke });
    const get = await app.inject({ method: "GET", url: `/v1/transactions/${hex("a")}`, headers });
    expect(post.statusCode).toBe(401);
    expect(get.statusCode).toBe(401);
    expect(calls).toEqual([]);
    expect(post.body).not.toContain(TOKEN);
  });

  it("submits an authorized request and ignores the caller-supplied rpcUrl", async () => {
    const { app, calls } = await server();
    const response = await app.inject({ method: "POST", url: "/", headers: { ...auth, "idempotency-key": "revoke:http-00001" }, payload: revoke });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ txHash: hex("b"), status: "PENDING" });
    expect(calls).toEqual(["getAccount", "prepare", "send"]);
  });

  it("reports a transaction's status", async () => {
    const { app } = await server();
    const response = await app.inject({ method: "GET", url: `/v1/transactions/${hex("a")}`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "SUCCESS" });
  });

  it("refuses a malformed transaction hash", async () => {
    const { app } = await server();
    const response = await app.inject({ method: "GET", url: "/v1/transactions/not-a-hash", headers: auth });
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ["a missing idempotency key", {}],
    ["a too-short idempotency key", { "idempotency-key": "short" }],
    ["an idempotency key with unsafe characters", { "idempotency-key": "bad key with spaces!" }],
  ])("refuses %s", async (_label, headers) => {
    const { app, calls } = await server();
    const response = await app.inject({ method: "POST", url: "/", headers: { ...auth, ...headers }, payload: revoke });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(calls).toEqual([]);
  });

  it.each([
    ["an unknown top-level field", { ...revoke, sourceAccount: signer.publicKey() }],
    ["a missing method", { network: "testnet", contractId: CONSENT, args: {} }],
    ["nested argument values", { ...revoke, args: { grantRef: { nested: true } } }],
    ["a non-object body", "just text"],
  ])("rejects %s with a generic 400", async (_label, payload) => {
    const { app, calls } = await server();
    const response = await app.inject({ method: "POST", url: "/", headers: { ...auth, "idempotency-key": "revoke:body-000001", "content-type": "application/json" }, payload: JSON.stringify(payload) });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("maps signer refusals to their status codes without leaking internals", async () => {
    const { app } = await server();
    const notAllowed = await app.inject({ method: "POST", url: "/", headers: { ...auth, "idempotency-key": "revoke:refuse-00001" }, payload: { ...revoke, contractId: PROVIDER } });
    expect(notAllowed.statusCode).toBe(422);
    expect(notAllowed.json().error.code).toBe("CONTRACT_NOT_ALLOWED");
    const badMethod = await app.inject({ method: "POST", url: "/", headers: { ...auth, "idempotency-key": "revoke:refuse-00002" }, payload: { ...revoke, method: "upgrade" } });
    expect(badMethod.statusCode).toBe(422);
    expect(JSON.stringify([notAllowed.json(), badMethod.json()])).not.toMatch(/stack|node_modules|\.ts/);
  });

  it("rejects an oversized body", async () => {
    const { app } = await server();
    const response = await app.inject({ method: "POST", url: "/", headers: { ...auth, "idempotency-key": "revoke:large-000001", "content-type": "application/json" }, payload: JSON.stringify({ ...revoke, args: { grantRef: "x".repeat(40_000) } }) });
    expect(response.statusCode).toBe(413);
  });

  it("returns 409 when an idempotency key is reused for a different operation", async () => {
    const { app } = await server();
    const headers = { ...auth, "idempotency-key": "revoke:conflict-0001" };
    await app.inject({ method: "POST", url: "/", headers, payload: revoke });
    const conflict = await app.inject({ method: "POST", url: "/", headers, payload: { ...revoke, args: { grantRef: hex("2") } } });
    expect(conflict.statusCode).toBe(409);
  });
});

describe("loadSignerConfig", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const seed = Keypair.random().secret();
  const base = (): NodeJS.ProcessEnv => ({
    STELLAR_NETWORK: "testnet",
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    SIGNER_AUTH_TOKEN: TOKEN,
    STELLAR_SIGNER_SECRET: seed,
    STELLAR_CONSENT_CONTRACT_ID: CONSENT,
    STELLAR_PROVIDER_CONTRACT_ID: PROVIDER,
  });

  it("accepts a development configuration and maps contracts to roles", () => {
    const loaded = loadSignerConfig(base());
    expect(loaded.network).toBe("testnet");
    expect(loaded.passphrase).toBe(Networks.TESTNET);
    expect(loaded.contracts.get(CONSENT)).toBe("consent");
    expect(loaded.contracts.get(PROVIDER)).toBe("provider");
    expect(loaded.keypair.secret()).toBe(seed);
    expect(loaded.host).toBe("127.0.0.1");
    expect(loaded.port).toBe(8787);
  });

  it("reads the key from a mounted secret file", () => {
    const directory = mkdtempSync(join(tmpdir(), "signer-key-"));
    directories.push(directory);
    const file = join(directory, "seed");
    writeFileSync(file, `${seed}\n`);
    const { STELLAR_SIGNER_SECRET: _omit, ...rest } = base();
    void _omit;
    const loaded = loadSignerConfig({ ...rest, STELLAR_SIGNER_SECRET_FILE: file, NODE_ENV: "production" });
    expect(loaded.keypair.secret()).toBe(seed);
  });

  it.each([
    ["an inline key in production", { NODE_ENV: "production" }],
    ["both a key file and an inline key", { STELLAR_SIGNER_SECRET_FILE: "/run/secrets/x" }],
    ["a short auth token", { SIGNER_AUTH_TOKEN: "short" }],
    ["a missing auth token", { SIGNER_AUTH_TOKEN: undefined }],
    ["an unknown network", { STELLAR_NETWORK: "elsewhere" }],
    ["a missing network", { STELLAR_NETWORK: undefined }],
    ["the local network in production", { STELLAR_NETWORK: "local", STELLAR_RPC_URL: "https://rpc.example", NODE_ENV: "production" }],
    ["plain HTTP outside the local network", { STELLAR_RPC_URL: "http://soroban-testnet.stellar.org" }],
    ["a missing RPC URL", { STELLAR_RPC_URL: undefined }],
    ["an invalid contract ID", { STELLAR_CONSENT_CONTRACT_ID: "not-a-contract" }],
    ["a duplicated contract ID", { STELLAR_PROVIDER_CONTRACT_ID: CONSENT }],
    ["a missing key", { STELLAR_SIGNER_SECRET: undefined }],
    ["an invalid key", { STELLAR_SIGNER_SECRET: "SNOTAKEY" }],
    ["an invalid port", { SIGNER_PORT: "99999" }],
    ["an excessive confirmation wait", { SIGNER_CONFIRM_WAIT_MS: "999999" }],
  ])("refuses %s", (_label, overrides) => {
    const env = { ...base(), ...overrides } as NodeJS.ProcessEnv;
    expect(() => loadSignerConfig(env)).toThrow();
  });

  it("refuses when no contract is configured", () => {
    const env = base();
    delete env.STELLAR_CONSENT_CONTRACT_ID;
    delete env.STELLAR_PROVIDER_CONTRACT_ID;
    expect(() => loadSignerConfig(env)).toThrow(/contract/i);
  });

  it("allows plain HTTP only on the local network", () => {
    const loaded = loadSignerConfig({ ...base(), STELLAR_NETWORK: "local", STELLAR_RPC_URL: "http://localhost:8000/rpc" });
    expect(loaded.allowHttp).toBe(true);
    expect(loaded.passphrase).toBe(Networks.STANDALONE);
  });

  it("never puts the secret seed in an error message", () => {
    try {
      loadSignerConfig({ ...base(), STELLAR_NETWORK: "elsewhere" });
    } catch (error) {
      expect(String(error)).not.toContain(seed);
    }
    try {
      loadSignerConfig({ ...base(), STELLAR_SIGNER_SECRET: `${seed}X` });
    } catch (error) {
      expect(String(error)).not.toContain(seed);
    }
  });

  it("normalizes network aliases", () => {
    expect(canonicalNetwork("PUBLIC")?.name).toBe("mainnet");
    expect(canonicalNetwork("standalone")?.name).toBe("local");
    expect(canonicalNetwork("constructor")).toBeUndefined();
    expect(canonicalNetwork(undefined)).toBeUndefined();
  });
});
