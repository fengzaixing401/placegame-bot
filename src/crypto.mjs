import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// 镜像 Python 版 placegame/security/crypto.py 的 SecretBox(AESGCM + AAD)。
// 主密钥经 env 注入(PLACEGAME_MASTER_KEY_B64),base64url 解码后须为 32 字节。
export function encryptedAad(table, recordId, column) {
  return `${table}:${recordId}:${column}`;
}

export class SecretBox {
  constructor(keyB64) {
    let key;
    try {
      key = Buffer.from(keyB64, "base64url");
    } catch {
      throw new Error("PLACEGAME_MASTER_KEY_B64 必须是有效的 base64url");
    }
    if (key.length !== 32) {
      throw new Error("PLACEGAME_MASTER_KEY_B64 解码后必须是 32 字节");
    }
    this.key = key;
  }

  encrypt(value, { aad }) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // 存储格式:base64url(nonce || tag || ciphertext)。解密时按长度切分。
    return Buffer.concat([nonce, tag, ct]).toString("base64url");
  }

  decrypt(blob, { aad }) {
    const raw = Buffer.from(blob, "base64url");
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}