import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Account, Keypair, Networks, type Transaction } from "@stellar/stellar-sdk";
import { encodeCall, METHODS, SignerError } from "../src/signer/contracts.js";
import type { SignerConfig } from "../src/signer/config.js";
import { FileIdempotencyStore, MemoryIdempotencyStore, SignerService, type SignerRpc } from "../src/signer/service.js";

// Public Testnet contract IDs from BUILD_STATUS.md. Nothing here ever reaches a network.
const CONSENT = "CCLKF6V5NV5KWIZMIYN4YSJXWCUK7PFYIRXSRVO7OM2AO2HDVCFXFCED";
const PROVIDER = "CBSULDGXAYGMMME5X47TIAJZ3IKTTRNR2Y4KSCZKKOPY4E37BY6IM57U";
const ATTESTATION = "CDDZTXZBRZIC6BAWOZO4MADR7MG7WO7CJFYS2M44C2426A34FQKEZ52Y";
const UNLISTED = "CBXGHZKUKRPRKYWN2TNFOPC7XVGF2IMOVZFATYR4JABYUPSXW4SEJHHJ";

const makeService = (cfg: SignerConfig, rpc: SignerRpc, store?: MemoryIdempotencyStore) => new SignerService(cfg, rpc, store, 5);
const signer = Keypair.random();
const patientWallet = Keypair.random().publicKey();
const hex = (digit: string) => digit.repeat(64);

function config(overrides: Partial<SignerConfig> = {}): SignerConfig {
  return {
    network: "testnet",
    passphrase: Networks.TESTNET,
    rpcUrl: "https://rpc.invalid",
    allowHttp: false,
    authToken: "t".repeat(32),
    keypair: signer,
    contracts: new Map([
      [CONSENT, "consent"],
      [PROVIDER, "provider"],
      [ATTESTATION, "attestation"],
    ]),
    confirmWaitMs: 500,
    host: "127.0.0.1",
    port: 0,
    ...overrides,
  };
}

type FakeOptions = { prepareFails?: boolean; sendStatus?: string[]; sendThrows?: number; txStatus?: () => string };

function fakeRpc(options: FakeOptions = {}) {
  const sent: Transaction[] = [];
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let sendAttempts = 0;
  let sequence = 100;
  const rpc: SignerRpc = {
    async getAccount(publicKey) {
      calls.push("getAccount");
      return new Account(publicKey, String(sequence));
    },
    async prepareTransaction(tx) {
      calls.push("prepare");
      if (options.prepareFails) throw new Error("simulation failed: grant exists");
      return tx;
    },
    async sendTransaction(tx) {
      calls.push("send");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      sendAttempts += 1;
      if (options.sendThrows && sendAttempts <= options.sendThrows) throw new Error("network down");
      const status = options.sendStatus?.[sendAttempts - 1] ?? "PENDING";
      if (status === "PENDING") {
        sent.push(tx);
        sequence += 1;
      }
      return { status, hash: String(sent.length).padStart(64, "a") };
    },
    async getTransaction() {
      calls.push("get");
      return { status: options.txStatus ? options.txStatus() : "SUCCESS" };
    },
  };
  return { rpc, sent, calls, maxInFlight: () => maxInFlight };
}

const grantArgs = (overrides: Record<string, string | number | boolean> = {}) => ({
  grantRef: hex("1"),
  subjectRef: hex("2"),
  recipient: patientWallet,
  scopeHash: hex("3"),
  startsAt: 1_800_000_000,
  expiresAt: 4_102_444_800,
  ...overrides,
});
const grant = (args = grantArgs()) => ({ network: "testnet", contractId: CONSENT, method: "grant", args });

describe("encodeCall", () => {
  const address = signer.publicKey();

  it("emits the contract's positional arguments and inserts the signer as grantor", () => {
    const values = JSON.parse(JSON.stringify(encodeCall("consent", "grant", grantArgs(), address))) as Record<string, unknown>[];
    expect(values).toHaveLength(7);
    expect(values[0]).toEqual({ bytes: hex("1") });
    expect(values[1]).toEqual({ address });
    expect(values[2]).toEqual({ bytes: hex("2") });
    expect(values[3]).toEqual({ address: patientWallet });
    expect(values[4]).toEqual({ bytes: hex("3") });
    expect(values[5]).toEqual({ u64: "1800000000" });
    expect(values[6]).toEqual({ u64: "4102444800" });
  });

  it("covers every method the API's StellarAdapter can send", () => {
    expect(Object.keys(METHODS.consent)).toEqual(["grant", "revoke"]);
    expect(Object.keys(METHODS.provider)).toEqual(["register", "set_status"]);
    expect(Object.keys(METHODS.attestation)).toEqual(["attest"]);
  });

  it.each([
    ["an unknown method", "consent", "upgrade", grantArgs()],
    ["a constructor", "consent", "__constructor", {}],
    ["an inherited property name", "consent", "constructor", {}],
    ["an unexpected argument", "consent", "revoke", { grantRef: hex("1"), extra: "x" }],
    ["a missing argument", "consent", "revoke", {}],
    ["short hex", "consent", "revoke", { grantRef: "abcd" }],
    ["non-hex characters", "consent", "revoke", { grantRef: "z".repeat(64) }],
    ["a number where bytes belong", "consent", "revoke", { grantRef: 12345 }],
    ["an invalid address", "consent", "grant", grantArgs({ recipient: "not-an-address" })],
    ["a negative timestamp", "consent", "grant", grantArgs({ startsAt: -1 })],
    ["a fractional timestamp", "consent", "grant", grantArgs({ expiresAt: 1.5 })],
    ["an unsafe integer", "consent", "grant", grantArgs({ expiresAt: Number.MAX_SAFE_INTEGER + 2 })],
    ["a u64 overflow", "consent", "grant", grantArgs({ expiresAt: "18446744073709551616" })],
    ["a boolean timestamp", "consent", "grant", grantArgs({ startsAt: true })],
    ["a non-boolean status", "provider", "set_status", { providerRef: hex("4"), verified: "maybe" }],
    ["another account as authority", "provider", "register", { providerRef: hex("4"), authority: patientWallet, metadataHash: hex("5") }],
    ["another account as issuer", "attestation", "attest", { recordRef: hex("6"), contentHash: hex("7"), issuer: patientWallet }],
  ] as const)("refuses %s", (_label, role, method, args) => {
    expect(() => encodeCall(role, method, args as Record<string, string | number | boolean>, address)).toThrow(SignerError);
  });

  it("accepts boolean strings, numeric strings and the signer as authority", () => {
    expect(() => encodeCall("provider", "set_status", { providerRef: hex("4"), verified: "true" }, address)).not.toThrow();
    expect(() => encodeCall("provider", "set_status", { providerRef: hex("4"), verified: false }, address)).not.toThrow();
    expect(() => encodeCall("consent", "grant", grantArgs({ startsAt: "0" }), address)).not.toThrow();
    expect(() => encodeCall("provider", "register", { providerRef: hex("4"), authority: address, metadataHash: hex("5") }, address)).not.toThrow();
  });
});

describe("SignerService.submit", () => {
  it("builds, signs and submits one invoke-contract transaction and reports its confirmed status", async () => {
    const fake = fakeRpc();
    const service = makeService(config({ confirmWaitMs: 300 }), fake.rpc);
    const result = await service.submit(grant(), "grant:one-0001");
    expect(result).toEqual({ txHash: "1".padStart(64, "a"), status: "SUCCESS" });
    expect(fake.sent).toHaveLength(1);
    const operation = JSON.parse(JSON.stringify(fake.sent[0].operations[0])) as { type: string; func: { invoke_contract: { contract_address: string; function_name: string; args: unknown[] } } };
    expect(operation.type).toBe("invokeHostFunction");
    expect(operation.func.invoke_contract.contract_address).toBe(CONSENT);
    expect(operation.func.invoke_contract.function_name).toBe("grant");
    expect(operation.func.invoke_contract.args).toHaveLength(7);
    expect(fake.sent[0].signatures).toHaveLength(1);
    expect(fake.sent[0].source).toBe(signer.publicKey());
  });

  it("returns PENDING when the ledger has not confirmed yet", async () => {
    const fake = fakeRpc({ txStatus: () => "NOT_FOUND" });
    const result = await makeService(config({ confirmWaitMs: 100 }), fake.rpc).submit(grant(), "grant:pending-1");
    expect(result.status).toBe("PENDING");
  });

  it("reports a failed transaction", async () => {
    const fake = fakeRpc({ txStatus: () => "FAILED" });
    const result = await makeService(config({ confirmWaitMs: 300 }), fake.rpc).submit(grant(), "grant:failed-01");
    expect(result.status).toBe("FAILED");
  });

  describe("idempotency", () => {
    it("never signs the same operation twice for one key", async () => {
      const fake = fakeRpc();
      const service = makeService(config(), fake.rpc);
      const first = await service.submit(grant(), "grant:repeat-01");
      const second = await service.submit(grant(), "grant:repeat-01");
      expect(second.txHash).toBe(first.txHash);
      expect(fake.calls.filter((c) => c === "send")).toHaveLength(1);
    });

    it("refuses to reuse a key for a different operation", async () => {
      const fake = fakeRpc();
      const service = makeService(config(), fake.rpc);
      await service.submit(grant(), "grant:conflict-1");
      await expect(service.submit(grant(grantArgs({ grantRef: hex("9") })), "grant:conflict-1")).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
      expect(fake.calls.filter((c) => c === "send")).toHaveLength(1);
    });

    it("lets a retry through after a transient submission failure", async () => {
      const fake = fakeRpc({ sendThrows: 1 });
      const service = makeService(config(), fake.rpc);
      await expect(service.submit(grant(), "grant:retry-001")).rejects.toMatchObject({ status: 503 });
      await expect(service.submit(grant(), "grant:retry-001")).resolves.toMatchObject({ status: "SUCCESS" });
      expect(fake.sent).toHaveLength(1);
    });

    it("refreshes a pending result instead of resubmitting", async () => {
      let status = "NOT_FOUND";
      const fake = fakeRpc({ txStatus: () => status });
      const service = makeService(config({ confirmWaitMs: 0 }), fake.rpc);
      expect((await service.submit(grant(), "grant:refresh-1")).status).toBe("PENDING");
      status = "SUCCESS";
      expect((await service.submit(grant(), "grant:refresh-1")).status).toBe("SUCCESS");
      expect(fake.sent).toHaveLength(1);
    });
  });

  describe("refusals happen before anything is signed or sent", () => {
    const refused = async (request: Parameters<SignerService["submit"]>[0], code: string, status = 422) => {
      const fake = fakeRpc();
      await expect(makeService(config(), fake.rpc).submit(request, "grant:refuse-001")).rejects.toMatchObject({ status, code });
      expect(fake.calls).toEqual([]);
    };

    it("a contract that is not configured", () => refused({ ...grant(), contractId: UNLISTED }, "CONTRACT_NOT_ALLOWED"));
    it("an arbitrary contract address", () => refused({ ...grant(), contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, "CONTRACT_NOT_ALLOWED"));
    it("a method the contract role does not allow", () => refused({ ...grant(), method: "set_admin" }, "METHOD_NOT_ALLOWED"));
    it("another role's method on this contract", () => refused({ ...grant(), method: "attest" }, "METHOD_NOT_ALLOWED"));
    it("a different network", () => refused({ ...grant(), network: "mainnet" }, "NETWORK_MISMATCH"));
    it("an unknown network", () => refused({ ...grant(), network: "elsewhere" }, "NETWORK_MISMATCH"));
    it("an invalid argument", () => refused(grant(grantArgs({ grantRef: "nope" })), "INVALID_ARGUMENT"));
  });

  it("refuses an operation the contract rejects in simulation, without sending", async () => {
    const fake = fakeRpc({ prepareFails: true });
    await expect(makeService(config(), fake.rpc).submit(grant(), "grant:reject-01")).rejects.toMatchObject({ status: 422, code: "CONTRACT_REJECTED" });
    expect(fake.calls).toEqual(["getAccount", "prepare"]);
  });

  it.each([
    ["ERROR", 502, "SUBMISSION_REJECTED"],
    ["TRY_AGAIN_LATER", 503, "RPC_BUSY"],
  ])("maps a %s network answer to %i and allows a retry", async (networkStatus, status, code) => {
    const fake = fakeRpc({ sendStatus: [networkStatus] });
    const service = makeService(config(), fake.rpc);
    await expect(service.submit(grant(), "grant:network-01")).rejects.toMatchObject({ status, code });
    await expect(service.submit(grant(), "grant:network-01")).resolves.toMatchObject({ status: "SUCCESS" });
  });

  it("treats a DUPLICATE network answer as accepted", async () => {
    const fake = fakeRpc({ sendStatus: ["DUPLICATE"] });
    await expect(makeService(config(), fake.rpc).submit(grant(), "grant:duplicate1")).resolves.toMatchObject({ status: "SUCCESS" });
  });

  it("submits strictly one transaction at a time", async () => {
    const fake = fakeRpc();
    const service = makeService(config(), fake.rpc);
    const results = await Promise.all([1, 2, 3, 4].map((n) => service.submit(grant(grantArgs({ grantRef: hex(String(n)) })), `grant:parallel-${n}`)));
    expect(results).toHaveLength(4);
    expect(fake.maxInFlight()).toBe(1);
    expect(fake.sent.map((tx) => tx.sequence)).toEqual(["101", "102", "103", "104"]);
  });

  it("signs revoke, provider and attestation calls for their own contracts", async () => {
    const fake = fakeRpc();
    const service = makeService(config(), fake.rpc);
    await service.submit({ network: "testnet", contractId: CONSENT, method: "revoke", args: { grantRef: hex("1") } }, "revoke:one-00001");
    await service.submit({ network: "testnet", contractId: PROVIDER, method: "register", args: { providerRef: hex("4"), authority: signer.publicKey(), metadataHash: hex("5") } }, "register:one-0001");
    await service.submit({ network: "testnet", contractId: PROVIDER, method: "set_status", args: { providerRef: hex("4"), verified: "true" } }, "status:one-000001");
    await service.submit({ network: "testnet", contractId: ATTESTATION, method: "attest", args: { recordRef: hex("6"), contentHash: hex("7"), issuer: signer.publicKey() } }, "attest:one-000001");
    const names = fake.sent.map((tx) => (JSON.parse(JSON.stringify(tx.operations[0])) as { func: { invoke_contract: { function_name: string } } }).func.invoke_contract.function_name);
    expect(names).toEqual(["revoke", "register", "set_status", "attest"]);
  });
});

describe("SignerService.status", () => {
  it.each([
    ["SUCCESS", "SUCCESS"],
    ["FAILED", "FAILED"],
    ["NOT_FOUND", "PENDING"],
    ["SOMETHING_ELSE", "PENDING"],
  ])("maps %s to %s", async (rpcStatus, expected) => {
    const service = makeService(config(), fakeRpc({ txStatus: () => rpcStatus }).rpc);
    await expect(service.status(hex("a"))).resolves.toBe(expected);
  });

  it("refuses a malformed hash without calling the RPC", async () => {
    const fake = fakeRpc();
    await expect(makeService(config(), fake.rpc).status("../etc/passwd")).rejects.toMatchObject({ status: 400 });
    expect(fake.calls).toEqual([]);
  });
});

describe("idempotency stores", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("MemoryIdempotencyStore returns what was stored", () => {
    const store = new MemoryIdempotencyStore();
    store.set("k", { fingerprint: "f", result: { txHash: hex("a"), status: "SUCCESS" } });
    expect(store.get("k")?.result.status).toBe("SUCCESS");
    expect(store.get("other")).toBeUndefined();
  });

  it("FileIdempotencyStore survives a restart, so a retry after a crash does not resubmit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "signer-"));
    directories.push(directory);
    const path = join(directory, "state.jsonl");
    const first = fakeRpc();
    await makeService(config(), first.rpc, new FileIdempotencyStore(path)).submit(grant(), "grant:restart-01");
    const second = fakeRpc();
    const result = await makeService(config(), second.rpc, new FileIdempotencyStore(path)).submit(grant(), "grant:restart-01");
    expect(result.status).toBe("SUCCESS");
    expect(second.calls.filter((c) => c === "send")).toHaveLength(0);
  });
});
