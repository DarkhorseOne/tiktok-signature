import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

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
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") {
    // 非钥匙串加密，按明文返回
    return encrypted.toString("utf8");
  }
  const body = encrypted.subarray(3);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, IV);
  decipher.setAutoPadding(true);
  let decrypted = Buffer.concat([decipher.update(body), decipher.final()]);
  if (stripDomainHash) decrypted = decrypted.subarray(32);
  return decrypted.toString("utf8");
}

/** Chrome expires_utc（1601 微秒纪元）-> Unix 秒；0/无效 -> undefined（会话 cookie） */
export function chromeTimeToUnix(expiresUtc) {
  const n = Number(expiresUtc);
  if (!n || n <= 0) return undefined;
  return Math.floor(n / 1e6 - CHROME_EPOCH_OFFSET_SECONDS);
}

/** 把一条 sqlite 行（含 hex 密文）映射为 Puppeteer setCookie 对象；解密失败返回 null */
export function rowToCookie(row, key, { stripDomainHash } = {}) {
  let value;
  try {
    value = decryptValue(Buffer.from(row.enc, "hex"), key, { stripDomainHash });
  } catch (e) {
    return null;
  }
  const cookie = {
    name: row.name,
    value,
    domain: row.domain,
    path: row.path || "/",
    secure: !!row.secure,
    httpOnly: !!row.httpOnly,
  };
  const expires = chromeTimeToUnix(row.expires);
  if (expires !== undefined) cookie.expires = expires;
  return cookie;
}

const KEYCHAIN_SERVICE = "Chrome Safe Storage";
const DOMAIN_HASH_VERSION = 24; // meta.version >= 24 => 解密后含 32 字节域名哈希

function chromeBaseDir() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
}

function getKeychainPassword() {
  // 首次会弹一次 GUI 授权；点"始终允许"后续静默
  return execFileSync(
    "security",
    ["find-generic-password", "-ws", KEYCHAIN_SERVICE],
    { encoding: "utf8" },
  ).trim();
}

// 把 DB 拷到临时目录（绕开 Chrome 锁）后用 sqlite3 -json 查询
function querySqlite(dbPath, sql) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttck-"));
  try {
    const tmpDb = path.join(tmp, "Cookies");
    fs.copyFileSync(dbPath, tmpDb);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(dbPath + suffix)) {
        fs.copyFileSync(dbPath + suffix, tmpDb + suffix);
      }
    }
    let out;
    try {
      out = execFileSync(process.env.SQLITE3_BIN || "sqlite3", [
        "-json",
        tmpDb,
        sql,
      ], { encoding: "utf8" });
    } catch (e) {
      // Only fall back when the first binary is missing; re-throw real DB/SQL errors.
      if (e.code !== "ENOENT") throw e;
      out = execFileSync("/usr/bin/sqlite3", ["-json", tmpDb, sql], {
        encoding: "utf8",
      });
    }
    const t = out.trim();
    return t ? JSON.parse(t) : [];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readMetaVersion(dbPath) {
  const rows = querySqlite(
    dbPath,
    "SELECT value FROM meta WHERE key='version';",
  );
  return rows.length ? Number(rows[0].value) : 0;
}

function readCookieRows(dbPath) {
  return querySqlite(
    dbPath,
    "SELECT name, host_key AS domain, path, is_secure AS secure, " +
      "is_httponly AS httpOnly, expires_utc AS expires, " +
      "hex(encrypted_value) AS enc FROM cookies WHERE host_key LIKE '%tiktok.com';",
  );
}

function profileHasLogin(dbPath) {
  try {
    const rows = querySqlite(
      dbPath,
      "SELECT count(*) AS n FROM cookies WHERE host_key LIKE '%tiktok.com' " +
        "AND name IN ('sessionid','sessionid_ss','sid_guard');",
    );
    return rows.length ? Number(rows[0].n) > 0 : false;
  } catch (e) {
    return false;
  }
}

function resolveProfileDb(baseDir, requested) {
  if (requested && requested !== "auto") {
    return path.join(baseDir, requested, "Cookies");
  }
  const candidates = ["Default"];
  for (let i = 1; i <= 20; i++) candidates.push(`Profile ${i}`);
  for (const name of candidates) {
    const db = path.join(baseDir, name, "Cookies");
    if (fs.existsSync(db) && profileHasLogin(db)) return db;
  }
  return path.join(baseDir, "Default", "Cookies");
}

/**
 * 从本机 Chrome 提取并解密 TikTok cookie。任何失败都返回 []（不抛）。
 * async 仅为让调用方统一 await；内部 I/O 全部同步。
 */
export async function getChromeTikTokCookies({ profile, chromeDir } = {}) {
  try {
    const baseDir = chromeDir || chromeBaseDir();
    const dbPath = resolveProfileDb(
      baseDir,
      profile ?? process.env.CHROME_PROFILE,
    );
    if (!fs.existsSync(dbPath)) {
      console.warn(`[auth] Chrome Cookies 不存在: ${dbPath}，回退匿名`);
      return [];
    }
    const stripDomainHash = readMetaVersion(dbPath) >= DOMAIN_HASH_VERSION;
    const key = deriveKey(getKeychainPassword());
    return readCookieRows(dbPath)
      .map((r) => rowToCookie(r, key, { stripDomainHash }))
      .filter(Boolean);
  } catch (e) {
    console.warn(`[auth] 读取 Chrome cookie 失败，回退匿名: ${e.message}`);
    return [];
  }
}
