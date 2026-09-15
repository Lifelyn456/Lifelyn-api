import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { encryptOriginal, decryptOriginal, type KeyWrapper } from "../../common/crypto.js";

type StoredEnvelope = { ciphertext: Buffer; iv: Buffer; tag: Buffer; wrappedKey: Buffer; keyRef: string; sha256: string };

@Injectable()
export class EnvironmentKeyWrapper implements KeyWrapper {
  private localKey() {
    if (process.env.NODE_ENV === "production") throw new ServiceUnavailableException("Production requires an external KMS adapter.");
    const key = Buffer.from(process.env.KMS_MASTER_KEY_BASE64 ?? "", "base64");
    if (key.length !== 32 || !process.env.KMS_KEY_REF) throw new ServiceUnavailableException("Envelope-encryption key management is not configured.");
    return key;
  }
  async wrap(dataKey: Buffer) {
    if (process.env.KMS_PROVIDER === "external") {
      const result = await this.external("wrap", { plaintextKey: dataKey.toString("base64"), keyRef: process.env.KMS_KEY_REF });
      const wrappedKey = Buffer.from(result.wrappedKey ?? "", "base64");
      if (!wrappedKey.length || !result.keyRef) throw new ServiceUnavailableException("KMS returned an invalid wrapped key.");
      return { wrappedKey, keyRef: result.keyRef };
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.localKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return { wrappedKey: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), keyRef: process.env.KMS_KEY_REF! };
  }
  async unwrap(wrappedKey: Buffer, keyRef: string) {
    if (process.env.KMS_PROVIDER === "external") {
      const result = await this.external("unwrap", { wrappedKey: wrappedKey.toString("base64"), keyRef });
      const plaintext = Buffer.from(result.plaintextKey ?? "", "base64");
      if (plaintext.length !== 32) throw new ServiceUnavailableException("KMS returned an invalid plaintext key.");
      return plaintext;
    }
    if (keyRef !== process.env.KMS_KEY_REF || wrappedKey.length < 29) throw new Error("KMS_KEY_MISMATCH");
    const decipher = createDecipheriv("aes-256-gcm", this.localKey(), wrappedKey.subarray(0, 12));
    decipher.setAuthTag(wrappedKey.subarray(12, 28));
    return Buffer.concat([decipher.update(wrappedKey.subarray(28)), decipher.final()]);
  }
  private async external(operation: "wrap" | "unwrap", body: Record<string, string | undefined>) {
    const endpoint = process.env.KMS_SERVICE_URL;
    const token = process.env.KMS_SERVICE_TOKEN;
    if (!endpoint || !token || !process.env.KMS_KEY_REF) throw new ServiceUnavailableException("External KMS is not configured.");
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/keys/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ServiceUnavailableException("External KMS operation failed.");
    return response.json() as Promise<{ wrappedKey?: string; plaintextKey?: string; keyRef?: string }>;
  }
}

@Injectable()
export class MalwareScanner {
  async assertClean(content: Buffer, mimeType: string) {
    const endpoint = process.env.MALWARE_SCANNER_URL;
    if (!endpoint) throw new ServiceUnavailableException("Malware scanning is not configured.");
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": mimeType, "x-content-sha256": createHash("sha256").update(content).digest("hex") }, body: new Uint8Array(content), signal: AbortSignal.timeout(30_000) });
    if (response.status === 422) throw new BadRequestException("The uploaded file did not pass malware scanning.");
    if (!response.ok) throw new ServiceUnavailableException("Malware scanning is unavailable.");
  }
}

@Injectable()
export class ObjectStorageService {
  private s3?: S3Client;
  constructor(private readonly kms: EnvironmentKeyWrapper, private readonly scanner: MalwareScanner) {}
  private config() {
    const { OBJECT_STORAGE_ENDPOINT: endpoint, OBJECT_STORAGE_BUCKET: bucket, OBJECT_STORAGE_ACCESS_KEY: accessKeyId, OBJECT_STORAGE_SECRET_KEY: secretAccessKey } = process.env;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new ServiceUnavailableException("Private object storage is not configured.");
    this.s3 ??= new S3Client({ region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1", endpoint, forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false", credentials: { accessKeyId, secretAccessKey } });
    return { client: this.s3, bucket };
  }
  async createUploadUrl(input: { recordId: string; mimeType: string }) {
    const { client, bucket } = this.config();
    const key = `staging/${input.recordId}`;
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: input.mimeType, Metadata: { "lifelyn-record": input.recordId } }), { expiresIn: 300 });
    return { objectKey: key, uploadUrl, expiresIn: 300, requiredHeaders: { "content-type": input.mimeType } };
  }
  async finalize(stagingKey: string, mimeType: string, declaredSize: number): Promise<StoredEnvelope & { objectKey: string; objectVersionId?: string }> {
    const { client, bucket } = this.config();
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: stagingKey }));
    if (!head.ContentLength || head.ContentLength !== declaredSize || head.ContentLength > 25 * 1024 * 1024) throw new BadRequestException("Uploaded size does not match the declared file size.");
    const fetched = await client.send(new GetObjectCommand({ Bucket: bucket, Key: stagingKey }));
    if (!fetched.Body) throw new BadRequestException("Uploaded object is empty.");
    const plaintext = Buffer.from(await fetched.Body.transformToByteArray());
    this.assertMime(plaintext, mimeType);
    await this.scanner.assertClean(plaintext, mimeType);
    const encrypted = await encryptOriginal(plaintext, this.kms);
    plaintext.fill(0);
    const objectKey = `records/${stagingKey.slice("staging/".length)}/v1.enc`;
    const stored = await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: encrypted.ciphertext, ContentType: "application/octet-stream", Metadata: { "lifelyn-encrypted": "aes-256-gcm", "plaintext-sha256": encrypted.sha256 } }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey }));
    return { ...encrypted, objectKey, objectVersionId: stored.VersionId };
  }
  async read(objectKey: string, envelope: Omit<StoredEnvelope, "ciphertext">) {
    const { client, bucket } = this.config();
    const fetched = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (!fetched.Body) throw new Error("OBJECT_NOT_FOUND");
    return decryptOriginal({ ...envelope, ciphertext: Buffer.from(await fetched.Body.transformToByteArray()) }, this.kms);
  }
  async integrityCheck(objectKey: string, envelope: Omit<StoredEnvelope, "ciphertext">) {
    const plaintext = await this.read(objectKey, envelope);
    plaintext.fill(0);
    return { verified: true, sha256: envelope.sha256 };
  }
  private assertMime(bytes: Buffer, mimeType: string) {
    const valid = mimeType === "application/pdf" ? bytes.subarray(0, 5).toString("ascii") === "%PDF-" : mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    if (!valid) throw new BadRequestException("File contents do not match the declared MIME type.");
  }
}
