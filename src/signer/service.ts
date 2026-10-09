import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { BASE_FEE, Contract, rpc, TransactionBuilder, type Account, type Transaction } from "@stellar/stellar-sdk";
import { canonicalNetwork, type SignerConfig } from "./config.js";
import { encodeCall, SignerError, type RawArgs } from "./contracts.js";

export type TxStatus = "PENDING" | "SUCCESS" | "FAILED";

/** The slice of the Soroban RPC client the signer needs. Tests substitute a fake. */
export interface SignerRpc {
  getAccount(publicKey: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<{ status: string; hash: string }>;
  getTransaction(hash: string): Promise<{ status: string }>;
}

export function createRpcClient(config: Pick<SignerConfig, "rpcUrl" | "allowHttp">): SignerRpc {
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp });
  return {
    getAccount: (publicKey) => server.getAccount(publicKey),
    prepareTransaction: (tx) => server.prepareTransaction(tx),
    sendTransaction: (tx) => server.sendTransaction(tx),
    getTransaction: (hash) => server.getTransaction(hash),
  };
}

export type SubmitRequest = { network: string; contractId: string; method: string; args: RawArgs };
export type SubmitResult = { txHash: string; status: TxStatus };
type Record_ = { fingerprint: string; result: SubmitResult };

/** Remembers the outcome of each idempotency key so a retry never signs a second transaction. */
export interface IdempotencyStore {
  get(key: string): Record_ | undefined;
  set(key: string, record: Record_): void;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  protected readonly records = new Map<string, Record_>();
  get(key: string) {
    return this.records.get(key);
  }
  set(key: string, record: Record_) {
    this.records.set(key, record);
  }
}

/** Keeps records in memory and appends each one to a JSON-lines file so they survive a restart. */
export class FileIdempotencyStore extends MemoryIdempotencyStore {
  constructor(private readonly path: string) {
    super();
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { key, record } = JSON.parse(line) as { key: string; record: Record_ };
      this.records.set(key, record);
    }
  }
  override set(key: string, record: Record_) {
    super.set(key, record);
    appendFileSync(this.path, `${JSON.stringify({ key, record })}\n`, { mode: 0o600 });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mapStatus(status: string): TxStatus {
  return status === "SUCCESS" ? "SUCCESS" : status === "FAILED" ? "FAILED" : "PENDING";
}

export class SignerService {
  /** Signing is strictly sequential: one transaction per account sequence number at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: SignerConfig,
    private readonly rpcClient: SignerRpc,
    private readonly store: IdempotencyStore = new MemoryIdempotencyStore(),
    private readonly pollMs = 1000,
  ) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async submit(request: SubmitRequest, idempotencyKey: string): Promise<SubmitResult> {
    // The request never chooses where to connect or which network to use: those come from this
    // service's own configuration. A mismatch means the caller is configured for another network.
    if (canonicalNetwork(request.network)?.name !== this.config.network) throw new SignerError(422, "NETWORK_MISMATCH", "The request targets a different network than this signer.");
    const role = this.config.contracts.get(request.contractId);
    if (!role) throw new SignerError(422, "CONTRACT_NOT_ALLOWED", "The signer does not sign calls to this contract.");
    const values = encodeCall(role, request.method, request.args, this.config.keypair.publicKey());
    const fingerprint = createHash("sha256").update(JSON.stringify([request.contractId, request.method, Object.entries(request.args).sort()])).digest("hex");

    return this.exclusive(async () => {
      const previous = this.store.get(idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new SignerError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different operation.");
        if (previous.result.status === "PENDING") {
          const refreshed = { ...previous, result: { ...previous.result, status: await this.status(previous.result.txHash) } };
          this.store.set(idempotencyKey, refreshed);
          return refreshed.result;
        }
        return previous.result;
      }

      const account = await this.rpcClient.getAccount(this.config.keypair.publicKey()).catch(() => {
        throw new SignerError(503, "RPC_UNAVAILABLE", "The Stellar RPC is unavailable.");
      });
      const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.config.passphrase })
        .addOperation(new Contract(request.contractId).call(request.method, ...values))
        .setTimeout(60)
        .build();
      // Preparing simulates the call, so a contract that would reject it (a duplicate grant, a
      // bad authority) is refused here, before anything is signed or paid for.
      const prepared = await this.rpcClient.prepareTransaction(built).catch(() => {
        throw new SignerError(422, "CONTRACT_REJECTED", "The contract rejected this operation in simulation.");
      });
      prepared.sign(this.config.keypair);
      const sent = await this.rpcClient.sendTransaction(prepared).catch(() => {
        throw new SignerError(503, "RPC_UNAVAILABLE", "The Stellar RPC is unavailable.");
      });
      if (sent.status === "TRY_AGAIN_LATER") throw new SignerError(503, "RPC_BUSY", "The network is busy. Retry later.");
      if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") throw new SignerError(502, "SUBMISSION_REJECTED", "The network rejected the transaction.");

      let status: TxStatus = "PENDING";
      const deadline = Date.now() + this.config.confirmWaitMs;
      while (status === "PENDING" && Date.now() < deadline) {
        await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
        status = await this.status(sent.hash).catch(() => "PENDING" as const);
      }
      const result = { txHash: sent.hash, status };
      // Recorded only after the network accepted it, so a transient failure can be retried.
      this.store.set(idempotencyKey, { fingerprint, result });
      return result;
    });
  }

  async status(txHash: string): Promise<TxStatus> {
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) throw new SignerError(400, "INVALID_HASH", "The transaction hash is not valid.");
    const found = await this.rpcClient.getTransaction(txHash).catch(() => {
      throw new SignerError(503, "RPC_UNAVAILABLE", "The Stellar RPC is unavailable.");
    });
    return mapStatus(found.status);
  }
}
