# Chrome Cookie 登录态注入 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TikTok 签名服务可选地以"登录态"运行——从本机 macOS Chrome 提取并解密 TikTok cookie，注入无头浏览器，使 `/fetch` / `/signature` 返回登录后数据。

**Architecture:** 零侵入。新增独立启动入口 `auth-server.mjs`，它在 `import` 原 `server.mjs` 前，给共享的 `puppeteer-extra` 单例包装 `launch`/`newPage` 钩子，在页面创建后、导航前 `page.setCookie()` 注入 cookie。提取/解密逻辑在独立的 `tiktok-auth/` 目录，原项目所有已跟踪文件一行不改。配套 `tiktokctl.sh` 做进程管理。任何失败都回退匿名模式。

**Tech Stack:** Node.js (ESM)、`puppeteer-extra`、Node `crypto`(AES-128-CBC/PBKDF2)、系统 `sqlite3` CLI、`security`(钥匙串)、jest 30 (ESM)、bash。

**分支:** `feature/chrome-cookie-auth`（已创建，spec 已提交）。所有 commit 在此分支。

**参考 spec:** [docs/superpowers/specs/2026-06-16-tiktok-chrome-cookie-auth-design.md](../specs/2026-06-16-tiktok-chrome-cookie-auth-design.md)

**单测运行约定:** `node --experimental-vm-modules node_modules/.bin/jest <文件路径>`（项目无 jest 配置文件，默认匹配 `**/__tests__/**/*.mjs`）。

---

## 文件结构

| 文件 | 职责 | 类型 |
|---|---|---|
| `tiktok-auth/chrome-cookies.mjs` | 从 Chrome 提取+解密 TikTok cookie，输出 Puppeteer 格式 | 新建 |
| `tiktok-auth/index.mjs` | `installAuthHook()`：包装 puppeteer 注入 cookie | 新建 |
| `auth-server.mjs` | 启动入口：装钩子后 import server.mjs | 新建 |
| `tiktokctl.sh` | 进程管理 start/stop/restart/status/log | 新建 |
| `tiktok-auth/README.md` | 用法 + 升级/merge 说明 + 安全提示 | 新建 |
| `tiktok-auth/__tests__/chrome-cookies.test.mjs` | 纯函数 + 回退 单测 | 新建 |
| `tiktok-auth/__tests__/launcher.test.mjs` | 钩子 + 启动入口 结构测试 | 新建 |
| `.env` | 追加 `TIKTOK_AUTH_ENABLED` / `CHROME_PROFILE`（gitignored，不提交） | 修改 |

原项目文件（`server.mjs`、`xgnarly.mjs`、`package.json`、`.gitignore`、`__tests__/`）**不改动**。

---

## Task 1: 解密与时间转换纯函数

**Files:**
- Create: `tiktok-auth/chrome-cookies.mjs`
- Test: `tiktok-auth/__tests__/chrome-cookies.test.mjs`

- [ ] **Step 1: 写失败的测试**

创建 `tiktok-auth/__tests__/chrome-cookies.test.mjs`：

```js
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
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/chrome-cookies.test.mjs`
Expected: FAIL，报 `Cannot find module '../chrome-cookies.mjs'`。

- [ ] **Step 3: 写最小实现**

创建 `tiktok-auth/chrome-cookies.mjs`：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/chrome-cookies.test.mjs`
Expected: PASS（4 个用例全过）。

- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/chrome-cookies.mjs tiktok-auth/__tests__/chrome-cookies.test.mjs
git commit -m "feat(auth): chrome cookie decrypt + time helpers"
```

---

## Task 2: row -> Puppeteer cookie 映射

**Files:**
- Modify: `tiktok-auth/chrome-cookies.mjs`
- Test: `tiktok-auth/__tests__/chrome-cookies.test.mjs`

- [ ] **Step 1: 追加失败的测试**

在 `tiktok-auth/__tests__/chrome-cookies.test.mjs` 顶部 import 里加上 `rowToCookie`：

```js
import {
  deriveKey,
  decryptValue,
  chromeTimeToUnix,
  rowToCookie,
} from "../chrome-cookies.mjs";
```

并在文件末尾追加：

```js
describe("rowToCookie mapping", () => {
  const key = deriveKey("test-password");

  test("maps sqlite row to puppeteer cookie and decrypts", () => {
    const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
    const enc = Buffer.concat([
      Buffer.from("v10", "latin1"),
      Buffer.concat([
        cipher.update(Buffer.concat([crypto.randomBytes(32), Buffer.from("v")])),
        cipher.final(),
      ]),
    ]);
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
    // "v10" 前缀 + 5 字节 body（非 16 的倍数）-> AES final 抛错 -> null
    const row = {
      name: "x",
      domain: ".tiktok.com",
      path: "/",
      secure: 0,
      httpOnly: 0,
      expires: 0,
      enc: "763130" + "0102030405", // hex("v10") + 5 bytes
    };
    expect(rowToCookie(row, key, { stripDomainHash: true })).toBeNull();
  });

  test("includes expires for non-session cookies", () => {
    const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
    const enc = Buffer.concat([
      Buffer.from("v10", "latin1"),
      Buffer.concat([
        cipher.update(Buffer.concat([crypto.randomBytes(32), Buffer.from("y")])),
        cipher.final(),
      ]),
    ]);
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/chrome-cookies.test.mjs`
Expected: FAIL，报 `rowToCookie is not a function`。

- [ ] **Step 3: 实现 rowToCookie**

在 `tiktok-auth/chrome-cookies.mjs` 末尾追加：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/chrome-cookies.test.mjs`
Expected: PASS（共 7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/chrome-cookies.mjs tiktok-auth/__tests__/chrome-cookies.test.mjs
git commit -m "feat(auth): map sqlite row to puppeteer cookie"
```

---

## Task 3: 提取编排器 getChromeTikTokCookies（含 shell 助手 + 回退）

**Files:**
- Modify: `tiktok-auth/chrome-cookies.mjs`
- Test: `tiktok-auth/__tests__/chrome-cookies.test.mjs`

- [ ] **Step 1: 追加失败的测试（验证回退契约：不存在的目录返回 [] 而非抛错）**

在 import 里加上 `getChromeTikTokCookies`：

```js
import {
  deriveKey,
  decryptValue,
  chromeTimeToUnix,
  rowToCookie,
  getChromeTikTokCookies,
} from "../chrome-cookies.mjs";
```

文件末尾追加：

```js
describe("getChromeTikTokCookies fallback", () => {
  test("returns [] (does not throw) when chrome dir is missing", async () => {
    const result = await getChromeTikTokCookies({
      chromeDir: "/definitely/not/here",
      profile: "Default",
    });
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/chrome-cookies.test.mjs`
Expected: FAIL，报 `getChromeTikTokCookies is not a function`。

- [ ] **Step 3: 实现编排器与 shell 助手**

在 `tiktok-auth/chrome-cookies.mjs` 顶部补充 import：

```js
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
```

并在文件末尾追加：

```js
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

/** 从本机 Chrome 提取并解密 TikTok cookie。任何失败都返回 []（不抛）。 */
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/chrome-cookies.test.mjs`
Expected: PASS（共 8 个用例）。

- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/chrome-cookies.mjs tiktok-auth/__tests__/chrome-cookies.test.mjs
git commit -m "feat(auth): extract+decrypt tiktok cookies from local chrome"
```

---

## Task 4: installAuthHook（包装 puppeteer，导航前注入）

**Files:**
- Create: `tiktok-auth/index.mjs`
- Test: `tiktok-auth/__tests__/launcher.test.mjs`

- [ ] **Step 1: 写失败的测试**

创建 `tiktok-auth/__tests__/launcher.test.mjs`：

```js
import { installAuthHook } from "../index.mjs";

// 构造一个假的 puppeteer 单例：launch 返回带 newPage 的假 browser
function makeFakePuppeteer(events) {
  const fakePage = {
    setCookie: async (...cookies) => {
      events.push(["setCookie", cookies.length]);
    },
  };
  const fakeBrowser = {
    newPage: async () => {
      events.push(["newPage"]);
      return fakePage;
    },
  };
  return {
    launch: async () => {
      events.push(["launch"]);
      return fakeBrowser;
    },
  };
}

describe("installAuthHook", () => {
  test("disabled: returns false and does not wrap launch", async () => {
    const events = [];
    const pptr = makeFakePuppeteer(events);
    const before = pptr.launch;
    const installed = await installAuthHook(pptr, { enabled: false });
    expect(installed).toBe(false);
    expect(pptr.launch).toBe(before);
  });

  test("enabled: injects cookies on newPage before returning page", async () => {
    const events = [];
    const pptr = makeFakePuppeteer(events);
    const installed = await installAuthHook(pptr, {
      enabled: true,
      getCookies: async () => [
        { name: "sessionid", value: "x", domain: ".tiktok.com", path: "/" },
      ],
    });
    expect(installed).toBe(true);

    const browser = await pptr.launch();
    await browser.newPage();
    // 顺序必须是 newPage 之后、page 返回之前完成 setCookie
    expect(events).toEqual([["launch"], ["newPage"], ["setCookie", 1]]);
  });

  test("enabled but getCookies throws: still returns a page (anonymous fallback)", async () => {
    const events = [];
    const pptr = makeFakePuppeteer(events);
    await installAuthHook(pptr, {
      enabled: true,
      getCookies: async () => {
        throw new Error("boom");
      },
    });
    const browser = await pptr.launch();
    const page = await browser.newPage();
    expect(page).toBeDefined();
    expect(events).toEqual([["launch"], ["newPage"]]); // 没有 setCookie，但不抛
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/launcher.test.mjs`
Expected: FAIL，报 `Cannot find module '../index.mjs'`。

- [ ] **Step 3: 实现 installAuthHook**

创建 `tiktok-auth/index.mjs`：

```js
import { getChromeTikTokCookies } from "./chrome-cookies.mjs";

/**
 * 给 puppeteer-extra 单例装上 cookie 注入钩子。
 * 包装 launch -> 包装返回 browser 的 newPage -> 在页面创建后、调用方导航前 setCookie。
 * @param {object} puppeteer 共享的 puppeteer-extra 单例
 * @param {{enabled?: boolean, getCookies?: function}} [options]
 * @returns {Promise<boolean>} 是否已安装
 */
export async function installAuthHook(puppeteer, options = {}) {
  const enabled =
    options.enabled !== undefined
      ? options.enabled
      : process.env.TIKTOK_AUTH_ENABLED === "true";
  if (!enabled) return false;

  const getCookies = options.getCookies || getChromeTikTokCookies;
  const origLaunch = puppeteer.launch.bind(puppeteer);

  puppeteer.launch = async (...args) => {
    const browser = await origLaunch(...args);
    const origNewPage = browser.newPage.bind(browser);
    browser.newPage = async (...a) => {
      const page = await origNewPage(...a);
      try {
        const cookies = await getCookies({ profile: process.env.CHROME_PROFILE });
        if (cookies && cookies.length) {
          await page.setCookie(...cookies);
          const loggedIn = cookies.some((c) => c.name === "sessionid");
          console.log(
            `[auth] 注入 ${cookies.length} 个 TikTok cookie；登录态=${loggedIn ? "是" : "否"}`,
          );
        } else {
          console.warn("[auth] 未找到 TikTok 登录 cookie，回退匿名模式");
        }
      } catch (e) {
        console.warn(`[auth] cookie 注入失败，回退匿名模式：${e.message}`);
      }
      return page;
    };
    return browser;
  };
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/launcher.test.mjs`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/index.mjs tiktok-auth/__tests__/launcher.test.mjs
git commit -m "feat(auth): installAuthHook injects cookies before navigation"
```

---

## Task 5: 启动入口 auth-server.mjs

**Files:**
- Create: `auth-server.mjs`
- Test: `tiktok-auth/__tests__/launcher.test.mjs`（追加结构测试）

- [ ] **Step 1: 追加失败的结构测试**

在 `tiktok-auth/__tests__/launcher.test.mjs` 顶部加 import：

```js
import fs from "fs";
```

文件末尾追加（验证：装钩子在 import server.mjs 之前）：

```js
describe("auth-server.mjs entry ordering", () => {
  const src = fs.readFileSync(
    new URL("../../auth-server.mjs", import.meta.url),
    "utf8",
  );

  test("imports installAuthHook", () => {
    expect(src).toMatch(/installAuthHook/);
  });

  test("installs hook before importing server.mjs", () => {
    const hookIdx = src.indexOf("installAuthHook(");
    const serverIdx = src.indexOf('import("./server.mjs")');
    expect(hookIdx).toBeGreaterThan(-1);
    expect(serverIdx).toBeGreaterThan(-1);
    expect(hookIdx).toBeLessThan(serverIdx);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/launcher.test.mjs`
Expected: FAIL，报读取 `../../auth-server.mjs` 失败（ENOENT）。

- [ ] **Step 3: 实现入口**

创建 `auth-server.mjs`：

```js
#!/usr/bin/env node
/**
 * 登录态启动入口（附加组件，不修改上游 server.mjs）。
 * 先给共享的 puppeteer-extra 单例装上 cookie 注入钩子，再 import 原 server.mjs 启动服务。
 * 用法: node --env-file-if-exists=.env auth-server.mjs   （或 ./tiktokctl.sh start）
 */
import puppeteer from "puppeteer-extra";
import { installAuthHook } from "./tiktok-auth/index.mjs";

const installed = await installAuthHook(puppeteer);
console.log(
  installed
    ? "[auth] 登录态注入已启用 (TIKTOK_AUTH_ENABLED=true)"
    : "[auth] 登录态注入未启用，匿名模式 (设置 TIKTOK_AUTH_ENABLED=true 开启)",
);

await import("./server.mjs");
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/launcher.test.mjs`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add auth-server.mjs tiktok-auth/__tests__/launcher.test.mjs
git commit -m "feat(auth): auth-server.mjs launcher (hook then import server)"
```

---

## Task 6: 进程管理脚本 tiktokctl.sh

**Files:**
- Create: `tiktokctl.sh`

- [ ] **Step 1: 写脚本**

创建 `tiktokctl.sh`：

```bash
#!/usr/bin/env bash
# TikTok 签名服务（登录态版）进程管理。附加脚本，不触碰上游文件。
# 子命令: start stop restart status log
set -uo pipefail

cd "$(dirname "$0")"

ENTRY="auth-server.mjs"
PID_FILE="tiktok-auth/auth-server.pid"
LOG_FILE="tiktok-auth/auth-server.log"

PORT=8080
if [ -f .env ]; then
  envport="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]' || true)"
  [ -n "${envport:-}" ] && PORT="$envport"
fi

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  mkdir -p "$(dirname "$PID_FILE")"
  nohup node --env-file-if-exists=.env "$ENTRY" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if is_running; then
    echo "started (pid $(cat "$PID_FILE")), logs -> $LOG_FILE"
  else
    echo "failed to start; see $LOG_FILE"
    return 1
  fi
}

stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "graceful stop timed out, sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "stopped"
}

status() {
  if is_running; then
    echo "running (pid $(cat "$PID_FILE")) on port $PORT"
    curl -s "http://localhost:$PORT/health" 2>/dev/null || echo "(health 未响应)"
    echo
    return 0
  fi
  echo "not running"
  return 3
}

log() {
  [ -f "$LOG_FILE" ] || { echo "暂无日志: $LOG_FILE"; return 0; }
  tail -n 100 -f "$LOG_FILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  log | logs) log ;;
  *) echo "usage: $0 {start|stop|restart|status|log}"; exit 2 ;;
esac
```

- [ ] **Step 2: 加可执行权限 + 语法检查**

Run:
```bash
chmod +x tiktokctl.sh
bash -n tiktokctl.sh && echo "SYNTAX OK"
./tiktokctl.sh 2>&1 | head -1
```
Expected: 打印 `SYNTAX OK`；无参时打印 `usage: ./tiktokctl.sh {start|stop|restart|status|log}`。

- [ ] **Step 3: 冒烟测试 status（未运行）**

Run: `./tiktokctl.sh status; echo "exit=$?"`
Expected: 打印 `not running` 且 `exit=3`。

- [ ] **Step 4: 提交**

```bash
git add tiktokctl.sh
git commit -m "feat(auth): tiktokctl.sh process manager (start/stop/restart/status/log)"
```

---

## Task 7: 配置 .env + 文档 README

**Files:**
- Modify: `.env`（gitignored，不会进 commit）
- Create: `tiktok-auth/README.md`

- [ ] **Step 1: 追加 .env 配置**

Run（向已存在的 `.env` 追加，若键已存在则手动改值）：
```bash
printf '\n# TikTok 登录态注入（附加功能）\nTIKTOK_AUTH_ENABLED=true\n# 留空或 auto 自动探测含 sessionid 的 profile\nCHROME_PROFILE=Default\n' >> .env
grep -E 'TIKTOK_AUTH_ENABLED|CHROME_PROFILE' .env
```
Expected: 打印刚追加的两行。

- [ ] **Step 2: 写 README**

创建 `tiktok-auth/README.md`：

```markdown
# tiktok-auth — 登录态注入（附加组件）

让本项目以**已登录**的 TikTok 会话运行，从而抓取需要登录才能看到的数据。
**附加组件设计：不修改原项目任何已跟踪文件**，方便随时 merge 上游更新。

## 原理

启动入口 `auth-server.mjs` 在导入原 `server.mjs` 前，给共享的 `puppeteer-extra`
单例装上钩子：浏览器新建页面时，从本机 macOS Chrome 读取并解密 TikTok cookie
（`sessionid` 等），在导航前用 `page.setCookie()` 注入。于是 `/fetch` 直接返回登录
数据，`/signature` 返回的 cookies 也带登录态。

## 用法

1. 在 Chrome 里正常登录 TikTok（确认 `CHROME_PROFILE` 指向那个 profile，默认 `Default`，
   留空/`auto` 则自动探测）。
2. 在项目根目录 `.env` 设置：
   ```
   TIKTOK_AUTH_ENABLED=true
   CHROME_PROFILE=Default
   ```
3. 启动 / 管理：
   ```bash
   ./tiktokctl.sh start     # 后台启动
   ./tiktokctl.sh status    # 查看状态 + /health
   ./tiktokctl.sh log       # 实时日志
   ./tiktokctl.sh restart   # 重启
   ./tiktokctl.sh stop      # 停止
   ```
4. 首次运行 macOS 会弹"`security` 想访问钥匙串"，点**始终允许**。

## 关闭登录态

把 `.env` 里 `TIKTOK_AUTH_ENABLED` 改为 `false`（或用 `node server.mjs` 原入口启动），
行为与原项目完全一致。

## 安全提示 ⚠️

- `sessionid` 等同账号完全访问权限。`/signature`、`/fetch` 的响应会包含 cookie，
  **本服务仅限本机自用，切勿对外网暴露**。
- cookie 只在内存中处理，不落盘；临时 DB 拷贝用后即删；日志不打印 cookie 值。

## 升级上游

本组件全部为新增文件（`auth-server.mjs`、`tiktokctl.sh`、`tiktok-auth/`）。
直接 `git pull` / `git rebase` 上游，不会与这些文件冲突。
```

- [ ] **Step 3: 提交（仅 README，.env 被忽略不入库）**

```bash
git add tiktok-auth/README.md
git status --short   # 确认 .env 不在待提交列表
git commit -m "docs(auth): usage + security + upgrade notes"
```

---

## Task 8: 全量测试 + 手动端到端验证

**Files:** 无（验证）

- [ ] **Step 1: 跑全部单测，确认未破坏原有测试**

Run: `npm test`
Expected: 原 `__tests__/server.test.mjs` 与新增 `tiktok-auth/__tests__/*` 全部 PASS。

- [ ] **Step 2: 启动并查看日志确认注入**

Run:
```bash
./tiktokctl.sh start
./tiktokctl.sh log
```
Expected: 日志出现 `[auth] 登录态注入已启用` 和 `[auth] 注入 N 个 TikTok cookie；登录态=是`（N>0）。若弹钥匙串授权，点"始终允许"。看到后 `Ctrl-C` 退出 log（不影响后台服务）。

- [ ] **Step 3: 验证登录态生效（/fetch 取需登录的数据）**

Run（示例：拉取需要登录的"关注中"列表或你自己的私有数据接口；用你实际要抓的登录后接口替换 URL）：
```bash
curl -s -X POST http://localhost:8080/fetch \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.tiktok.com/api/user/detail/?uniqueId=zara&...（含必要参数）"}' | head -c 500
```
Expected: 返回 JSON 中体现登录态（例如返回了仅登录可见的字段；与关闭开关时对比应有差异）。
对比验证：`./tiktokctl.sh stop`，把 `.env` 的 `TIKTOK_AUTH_ENABLED=false` 后 `./tiktokctl.sh start`，同一请求应回到匿名结果。验证完改回 `true`。

- [ ] **Step 4: 验证 status / stop**

Run:
```bash
./tiktokctl.sh status; echo "exit=$?"
./tiktokctl.sh stop
./tiktokctl.sh status; echo "exit=$?"
```
Expected: 运行时 `running ...` 且 `exit=0` 并打印 /health JSON；stop 后 `not running` 且 `exit=3`。

- [ ] **Step 5: 最终提交（如有验证期间的微调）**

```bash
git add -A
git status --short
git commit -m "test(auth): end-to-end verification adjustments" || echo "无改动可提交"
```

---

## Self-Review 结论

- **Spec 覆盖:** §3.2 钩子→Task4/5；§3.3 零侵入→全程新文件；§3.4 控制脚本→Task6；§4 提取解密→Task1-3；§6 容错→Task3(编排器 try/catch)+Task4(注入 try/catch)+Task6(脚本守卫)；§7 安全→README(Task7)+不落盘实现；§8 测试→Task1-5 单测 + Task8 端到端。无遗漏。
- **占位符:** 无 TBD/TODO；所有代码步骤含完整代码与命令。
- **类型/命名一致:** `deriveKey`/`decryptValue`/`chromeTimeToUnix`/`rowToCookie`/`getChromeTikTokCookies`/`installAuthHook` 在各 Task 间签名一致；`stripDomainHash`、`enc`(hex)、`{profile, chromeDir}` 命名贯穿统一。
