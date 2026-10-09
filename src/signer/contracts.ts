import { Address, nativeToScVal, StrKey } from "@stellar/stellar-sdk";

/** Raised for any request the signer must refuse. `status` is the HTTP status to return. */
export class SignerError extends Error {
  constructor(
    readonly status: 400 | 401 | 409 | 422 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ContractRole = "consent" | "provider" | "attestation" | "receipt";

type ParamKind =
  /** BytesN<32>, sent as 64 hex characters. */
  | "bytes32"
  /** Any valid Stellar address. */
  | "address"
  /** An address that must equal the signer's own address, because only the signer's key can authorize it. */
  | "signerAddress"
  | "u64"
  | "bool"
  /** Not supplied by the caller: the signer inserts its own address (the on-chain actor). */
  | "signer";

type Param = { contractParam: string; apiArg?: string; kind: ParamKind };

/**
 * The only contract calls the signer will ever sign. Parameter order is the contract's
 * positional order (see Lifelyn-contracts/contracts/<name>/src/lib.rs). `apiArg` is the
 * camelCase name the API sends in `src/integrations/stellar.ts`.
 */
export const METHODS: Record<ContractRole, Record<string, readonly Param[]>> = {
  consent: {
    grant: [
      { contractParam: "grant_ref", apiArg: "grantRef", kind: "bytes32" },
      { contractParam: "grantor", kind: "signer" },
      { contractParam: "subject", apiArg: "subjectRef", kind: "bytes32" },
      { contractParam: "recipient", apiArg: "recipient", kind: "address" },
      { contractParam: "scope_hash", apiArg: "scopeHash", kind: "bytes32" },
      { contractParam: "starts_at", apiArg: "startsAt", kind: "u64" },
      { contractParam: "expires_at", apiArg: "expiresAt", kind: "u64" },
    ],
    revoke: [{ contractParam: "grant_ref", apiArg: "grantRef", kind: "bytes32" }],
  },
  provider: {
    register: [
      { contractParam: "provider_ref", apiArg: "providerRef", kind: "bytes32" },
      { contractParam: "authority", apiArg: "authority", kind: "signerAddress" },
      { contractParam: "metadata_hash", apiArg: "metadataHash", kind: "bytes32" },
    ],
    set_status: [
      { contractParam: "provider_ref", apiArg: "providerRef", kind: "bytes32" },
      { contractParam: "verified", apiArg: "verified", kind: "bool" },
    ],
  },
  attestation: {
    attest: [
      { contractParam: "record_ref", apiArg: "recordRef", kind: "bytes32" },
      { contractParam: "content_hash", apiArg: "contentHash", kind: "bytes32" },
      { contractParam: "issuer", apiArg: "issuer", kind: "signerAddress" },
    ],
  },
  receipt: {
    record_receipt: [
      { contractParam: "grant_ref", apiArg: "grantRef", kind: "bytes32" },
      { contractParam: "access_ref", apiArg: "accessRef", kind: "bytes32" },
      { contractParam: "purpose_hash", apiArg: "purposeHash", kind: "bytes32" },
    ],
  },
};

export type RawArgs = Record<string, string | number | boolean>;

const U64_MAX = 2n ** 64n - 1n;

function refuse(message: string): never {
  throw new SignerError(422, "INVALID_ARGUMENT", message);
}

function encode(name: string, kind: ParamKind, value: string | number | boolean, signerAddress: string) {
  switch (kind) {
    case "bytes32":
      if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) refuse(`${name} must be 64 hexadecimal characters.`);
      return nativeToScVal(Buffer.from(value as string, "hex"));
    case "address":
      if (typeof value !== "string" || !(StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) refuse(`${name} must be a valid Stellar address.`);
      return new Address(value as string).toScVal();
    case "signerAddress":
      if (value !== signerAddress) refuse(`${name} must be the signer's own address.`);
      return new Address(signerAddress).toScVal();
    case "u64": {
      let parsed: bigint;
      try {
        if (typeof value === "boolean" || (typeof value === "number" && !Number.isSafeInteger(value)) || (typeof value === "string" && !/^\d+$/.test(value))) throw new Error("not an integer");
        parsed = BigInt(value);
      } catch {
        return refuse(`${name} must be a non-negative integer.`);
      }
      if (parsed < 0n || parsed > U64_MAX) refuse(`${name} is out of range.`);
      return nativeToScVal(parsed, { type: "u64" });
    }
    case "bool":
      if (value === true || value === "true") return nativeToScVal(true);
      if (value === false || value === "false") return nativeToScVal(false);
      return refuse(`${name} must be true or false.`);
    case "signer":
      return new Address(signerAddress).toScVal();
  }
}

/**
 * Validates a request's arguments against the allowlisted method and returns the positional
 * Soroban values. Unknown methods, unknown or missing arguments, and malformed values are all
 * refused; nothing is guessed or defaulted.
 */
export function encodeCall(role: ContractRole, method: string, args: RawArgs, signerAddress: string) {
  const params = Object.hasOwn(METHODS[role], method) ? METHODS[role][method] : undefined;
  if (!params) throw new SignerError(422, "METHOD_NOT_ALLOWED", `The signer does not sign ${role}.${method}.`);
  const expected = new Set(params.flatMap((p) => (p.apiArg ? [p.apiArg] : [])));
  for (const key of Object.keys(args)) if (!expected.has(key)) refuse(`Unexpected argument: ${key}.`);
  return params.map((param) => {
    if (param.kind === "signer") return encode(param.contractParam, param.kind, "", signerAddress);
    const value = args[param.apiArg!];
    if (value === undefined) refuse(`Missing argument: ${param.apiArg}.`);
    return encode(param.apiArg!, param.kind, value, signerAddress);
  });
}
