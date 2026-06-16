import crypto from "crypto";
import {
  deriveKey,
  decryptValue,
  chromeTimeToUnix,
} from "../chrome-cookies.mjs";

const IV = Buffer.alloc(16, " ");

// 构造一个 Chrome macOS 风格的 v10 密文：
// "v10" 前缀 + AES-128-CBC( [可选32字节域名哈希] + 明文 )
function makeEncrypted(value, key, { withDomainHash }) {
  const parts = [];
  if (withDomainHash) parts.push(crypto.randomBytes(32));
  parts.push(Buffer.from(value, "utf8"));
  const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
  const enc = Buffer.concat([
    cipher.update(Buffer.concat(parts)),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from("v10", "latin1"), enc]);
}

describe("chrome-cookies decrypt + time", () => {
  const key = deriveKey("test-password");

  test("decryptValue round-trips a v10 cookie WITH domain hash (Chrome 130+)", () => {
    const enc = makeEncrypted("sess-abc-123", key, { withDomainHash: true });
    expect(decryptValue(enc, key, { stripDomainHash: true })).toBe(
      "sess-abc-123",
    );
  });

  test("decryptValue round-trips a v10 cookie WITHOUT domain hash (older Chrome)", () => {
    const enc = makeEncrypted("plainvalue", key, { withDomainHash: false });
    expect(decryptValue(enc, key, { stripDomainHash: false })).toBe(
      "plainvalue",
    );
  });

  test("chromeTimeToUnix converts micros-since-1601 to unix seconds", () => {
    const chromeMicros = (1700000000 + 11644473600) * 1e6;
    expect(chromeTimeToUnix(chromeMicros)).toBe(1700000000);
  });

  test("chromeTimeToUnix returns undefined for session cookies (0)", () => {
    expect(chromeTimeToUnix(0)).toBeUndefined();
  });

  test("decryptValue returns raw UTF-8 for unencrypted (non-v10/v11) values", () => {
    expect(decryptValue(Buffer.from("plaintext", "utf8"), key)).toBe("plaintext");
  });
});
