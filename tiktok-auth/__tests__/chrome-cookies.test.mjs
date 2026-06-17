import crypto from "crypto";
import {
  deriveKey,
  decryptValue,
  chromeTimeToUnix,
  rowToCookie,
  getChromeTikTokCookies,
} from "../chrome-cookies.mjs";
import {
  parseLocalStateNames,
  listChromeProfiles,
} from "../chrome-cookies.mjs";
import fsExtra from "fs";
import osExtra from "os";
import pathExtra from "path";

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

describe("rowToCookie mapping", () => {
  const key = deriveKey("test-password");

  test("maps sqlite row to puppeteer cookie and decrypts", () => {
    const enc = makeEncrypted("v", key, { withDomainHash: true });
    const row = {
      name: "sessionid",
      domain: ".tiktok.com",
      path: "/",
      secure: 1,
      httpOnly: 1,
      expires: 0,
      enc: enc.toString("hex"),
    };
    expect(rowToCookie(row, key, { stripDomainHash: true })).toEqual({
      name: "sessionid",
      value: "v",
      domain: ".tiktok.com",
      path: "/",
      secure: true,
      httpOnly: true,
    });
  });

  test("returns null for undecryptable value (skipped, not thrown)", () => {
    const row = {
      name: "x",
      domain: ".tiktok.com",
      path: "/",
      secure: 0,
      httpOnly: 0,
      expires: 0,
      enc: "763130" + "0102030405",
    };
    expect(rowToCookie(row, key, { stripDomainHash: true })).toBeNull();
  });

  test("includes expires for non-session cookies", () => {
    const enc = makeEncrypted("y", key, { withDomainHash: true });
    const row = {
      name: "sid_guard",
      domain: ".tiktok.com",
      path: "/",
      secure: 1,
      httpOnly: 0,
      expires: (1700000000 + 11644473600) * 1e6,
      enc: enc.toString("hex"),
    };
    const c = rowToCookie(row, key, { stripDomainHash: true });
    expect(c.expires).toBe(1700000000);
  });
});

describe("getChromeTikTokCookies fallback", () => {
  test("returns [] (does not throw) when chrome dir is missing", async () => {
    const result = await getChromeTikTokCookies({
      chromeDir: "/definitely/not/here",
      profile: "Default",
    });
    expect(result).toEqual([]);
  });
});

describe("parseLocalStateNames", () => {
  test("maps info_cache dir -> {name,email}", () => {
    const ls = JSON.stringify({
      profile: { info_cache: { "Profile 1": { name: "Work", user_name: "w@x.com" }, Default: { name: "Me" } } },
    });
    expect(parseLocalStateNames(ls)).toEqual({
      "Profile 1": { name: "Work", email: "w@x.com" },
      Default: { name: "Me", email: "" },
    });
  });
  test("bad JSON -> {}", () => {
    expect(parseLocalStateNames("not json")).toEqual({});
  });
});

describe("listChromeProfiles", () => {
  test("enumerates Local State dirs that have a Cookies file, merges name/email + hasLogin", () => {
    const dir = fsExtra.mkdtempSync(pathExtra.join(osExtra.tmpdir(), "ttls-"));
    fsExtra.mkdirSync(pathExtra.join(dir, "Default"));
    fsExtra.mkdirSync(pathExtra.join(dir, "Profile 1"));
    fsExtra.writeFileSync(pathExtra.join(dir, "Default", "Cookies"), "");
    fsExtra.writeFileSync(pathExtra.join(dir, "Profile 1", "Cookies"), "");
    const readLocalState = () =>
      JSON.stringify({ profile: { info_cache: { Default: { name: "Me", user_name: "" }, "Profile 1": { name: "Work", user_name: "w@x.com" } } } });
    const hasLogin = (db) => db.includes("Profile 1"); // 只有 Profile 1 已登录
    const res = listChromeProfiles({ chromeDir: dir, hasLogin, readLocalState });
    fsExtra.rmSync(dir, { recursive: true, force: true });
    expect(res).toEqual([
      { profile: "Default", hasLogin: false, name: "Me", email: "" },
      { profile: "Profile 1", hasLogin: true, name: "Work", email: "w@x.com" },
    ]);
  });
});
