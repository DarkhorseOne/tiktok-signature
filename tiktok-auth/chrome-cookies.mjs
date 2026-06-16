import crypto from "crypto";

const SALT = "saltysalt";
const ITERATIONS = 1003; // macOS
const KEY_LENGTH = 16; // AES-128
const IV = Buffer.alloc(16, " "); // 16 个空格字节
const CHROME_EPOCH_OFFSET_SECONDS = 11644473600; // 1601->1970 秒差

/** 用钥匙串密码派生 AES-128 密钥 */
export function deriveKey(password) {
  return crypto.pbkdf2Sync(password, SALT, ITERATIONS, KEY_LENGTH, "sha1");
}

/** 解密单个 encrypted_value（Buffer）。stripDomainHash=true 时切掉解密后前 32 字节。 */
export function decryptValue(encrypted, key, { stripDomainHash } = {}) {
  if (!Buffer.isBuffer(encrypted)) encrypted = Buffer.from(encrypted);
  const prefix = encrypted.slice(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") {
    // 非钥匙串加密，按明文返回
    return encrypted.toString("utf8");
  }
  const body = encrypted.slice(3);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, IV);
  decipher.setAutoPadding(true);
  let decrypted = Buffer.concat([decipher.update(body), decipher.final()]);
  if (stripDomainHash) decrypted = decrypted.slice(32);
  return decrypted.toString("utf8");
}

/** Chrome expires_utc（1601 微秒纪元）-> Unix 秒；0/无效 -> undefined（会话 cookie） */
export function chromeTimeToUnix(expiresUtc) {
  const n = Number(expiresUtc);
  if (!n || n <= 0) return undefined;
  return Math.floor(n / 1e6 - CHROME_EPOCH_OFFSET_SECONDS);
}
