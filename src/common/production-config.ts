const REQUIRED = [
  "DATABASE_URL", "REDIS_URL", "WEB_ORIGIN", "AUTH_JWT_SECRET", "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY", "OBJECT_STORAGE_SECRET_KEY", "KMS_KEY_REF",
  "KMS_SERVICE_URL", "KMS_SERVICE_TOKEN", "FIELD_ENCRYPTION_KEY_BASE64", "MALWARE_SCANNER_URL",
  "AI_BASE_URL", "AI_SERVICE_JWT_SECRET", "AI_PIPELINE_VERSION", "WEBAUTHN_RP_ID", "PROVIDER_VERIFIER_TOKEN", "ORG_VERIFIER_TOKEN",
  "STELLAR_NETWORK", "STELLAR_RPC_URL", "STELLAR_CONSENT_CONTRACT_ID",
  "STELLAR_PROVIDER_CONTRACT_ID", "STELLAR_PROVIDER_AUTHORITY_ADDRESS",
  "STELLAR_RECORD_ATTESTATION_CONTRACT_ID", "STELLAR_ACCESS_RECEIPT_CONTRACT_ID",
  "STELLAR_ATTESTATION_ISSUER_ADDRESS", "STELLAR_SIGNER_SERVICE_URL", "STELLAR_SIGNER_SERVICE_TOKEN",
] as const;

export function assertProductionConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== "production") return;
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  if (env.KMS_PROVIDER !== "external") throw new Error("Production requires KMS_PROVIDER=external");
  for (const name of ["WEB_ORIGIN", "OBJECT_STORAGE_ENDPOINT", "KMS_SERVICE_URL", "MALWARE_SCANNER_URL", "AI_BASE_URL", "STELLAR_RPC_URL", "STELLAR_SIGNER_SERVICE_URL"] as const) {
    if (new URL(env[name]!).protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  }
  if (Buffer.byteLength(env.AUTH_JWT_SECRET!) < 32 || Buffer.byteLength(env.AI_SERVICE_JWT_SECRET!) < 32 || Buffer.byteLength(env.PROVIDER_VERIFIER_TOKEN!) < 32 || Buffer.byteLength(env.ORG_VERIFIER_TOKEN!) < 32 || Buffer.byteLength(env.STELLAR_SIGNER_SERVICE_TOKEN!) < 32 || Buffer.byteLength(env.KMS_SERVICE_TOKEN!) < 32) throw new Error("Production service secrets must contain at least 32 bytes");
  if (Buffer.from(env.FIELD_ENCRYPTION_KEY_BASE64!, "base64").length !== 32) throw new Error("FIELD_ENCRYPTION_KEY_BASE64 must encode exactly 32 bytes");
}
