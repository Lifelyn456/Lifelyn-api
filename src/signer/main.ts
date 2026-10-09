import "dotenv/config";
import { loadSignerConfig } from "./config.js";
import { buildSignerServer } from "./server.js";
import { createRpcClient, FileIdempotencyStore, MemoryIdempotencyStore, SignerService } from "./service.js";

// Starts the private Stellar signing service. It holds the only signing key, accepts calls only
// from the API (bearer token), and signs only allowlisted calls to the configured contracts.
const config = loadSignerConfig();
const store = config.stateFile ? new FileIdempotencyStore(config.stateFile) : new MemoryIdempotencyStore();
if (!config.stateFile && process.env.NODE_ENV === "production") {
  console.warn("SIGNER_STATE_FILE is not set: idempotency records are lost on restart. The contracts reject duplicate operations, but set a state file on a persistent volume.");
}
const app = await buildSignerServer(new SignerService(config, createRpcClient(config), store), config.authToken);
await app.listen({ host: config.host, port: config.port });
// Log the public address only; never the key.
app.log.info({ network: config.network, signer: config.keypair.publicKey(), contracts: config.contracts.size }, "stellar signer ready");
