import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

@Injectable()
export class FieldCryptoService {
  private key() {
    const key = Buffer.from(process.env.FIELD_ENCRYPTION_KEY_BASE64 ?? "", "base64");
    if (key.length !== 32) throw new ServiceUnavailableException("Sensitive-field encryption is not configured.");
    return key;
  }
  encrypt(text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    return Buffer.concat([iv, cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  }
  decrypt(value: Uint8Array) {
    const bytes = Buffer.from(value);
    if (bytes.length < 29) throw new Error("INVALID_ENCRYPTED_FIELD");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
  }
}
