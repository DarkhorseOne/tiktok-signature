# 多账号 Profile 管理 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个统一 CLI 管理多个 TikTok 账号会话（每账号=一个 Chrome profile），提取后持久化到 `~/.tiktok-sig-auth`，启动时选择加载哪个账号。

**Architecture:** 全部 add-on，不碰上游。`profile add/refresh` 读 Chrome 解密并持久化；`start <name>` 从存储加载 cookie 注入无头浏览器。注入源由 `index.mjs` 的 `getConfiguredCookies` 决定（`TIKTOK_PROFILE`→存储；否则 `CHROME_PROFILE`→实时回退）。

**Tech Stack:** Node.js ESM、Node `crypto`/`fs`、系统 `sqlite3`/`security`、jest 30 (ESM)、bash。

**分支:** `feature/multi-account-profiles`（spec 已提交）。所有 commit 在此分支。

**Spec:** [docs/superpowers/specs/2026-06-16-multi-account-profile-management-design.md](../specs/2026-06-16-multi-account-profile-management-design.md)

**单测命令:** `node --experimental-vm-modules node_modules/.bin/jest <文件>`（无 jest 配置；默认匹配 `**/__tests__/**/*.mjs`）。新测试放 `tiktok-auth/__tests__/`。

---

## 文件结构

| 文件 | 职责 | 类型 |
|---|---|---|
| `tiktok-auth/constants.mjs` | `SESSION_COOKIE_NAMES` + `hasSessionCookie` | 新建 (Task 1) |
| `tiktok-auth/chrome-cookies.mjs` | 追加 `parseLocalStateNames` / `listChromeProfiles`；导出 `profileHasLogin`；用共享常量 | 修改 (Task 2) |
| `tiktok-auth/profile-store.mjs` | `~/.tiktok-sig-auth` 安全 CRUD + 备份 | 新建 (Task 3,4) |
| `tiktok-auth/cookie-import.mjs` | `parseImportFile` 自动识别 备份/扩展 | 新建 (Task 5) |
| `tiktok-auth/parse-args.mjs` | `parseProfileArg` 纯函数（可测，无副作用） | 新建 (Task 6) |
| `auth-server.mjs` | 用 `parseProfileArg` 设 `TIKTOK_PROFILE` | 修改 (Task 6) |
| `tiktok-auth/index.mjs` | `getConfiguredCookies` + 钩子无参调用（修签名冲突） | 修改 (Task 7) |
| `tiktok-auth/profile-cli.mjs` | `run(argv,deps)` 纯核心 + shim + 全部子命令 | 新建 (Task 8,9,10) |
| `tiktokctl.sh` | `profile` 透传 + `start [name]` + `status`/`restart` 解析 + DRY_RUN | 修改 (Task 11) |
| `tiktok-auth/README.md` | 文档 | 修改 (Task 12) |

---

## Task 1: 共享常量 constants.mjs

**Files:**
- Create: `tiktok-auth/constants.mjs`
- Test: `tiktok-auth/__tests__/constants.test.mjs`

- [ ] **Step 1: 写失败测试** — `tiktok-auth/__tests__/constants.test.mjs`:

```js
import { SESSION_COOKIE_NAMES, hasSessionCookie } from "../constants.mjs";

describe("constants", () => {
  test("SESSION_COOKIE_NAMES is the canonical session set", () => {
    expect(SESSION_COOKIE_NAMES).toEqual(["sessionid", "sessionid_ss", "sid_guard"]);
  });
  test("hasSessionCookie true when any session cookie present", () => {
    expect(hasSessionCookie([{ name: "sid_guard" }, { name: "x" }])).toBe(true);
  });
  test("hasSessionCookie false when none present / not array", () => {
    expect(hasSessionCookie([{ name: "x" }])).toBe(false);
    expect(hasSessionCookie(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/constants.test.mjs`
Expected: FAIL `Cannot find module '../constants.mjs'`。

- [ ] **Step 3: 实现** — `tiktok-auth/constants.mjs`:

```js
/** TikTok 登录态的权威 cookie 名集合（hasLogin / hasSession / 注入日志 统一引用） */
export const SESSION_COOKIE_NAMES = ["sessionid", "sessionid_ss", "sid_guard"];

/** cookies 数组中是否含任一会话 cookie */
export function hasSessionCookie(cookies) {
  return (
    Array.isArray(cookies) &&
    cookies.some((c) => c && SESSION_COOKIE_NAMES.includes(c.name))
  );
}
```

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS (3)。
- [ ] **Step 5: 提交**

```bash
cd /Users/nickma/Develop/TikTok/tiktok-signature
git add tiktok-auth/constants.mjs tiktok-auth/__tests__/constants.test.mjs
git commit -m "feat(profiles): shared SESSION_COOKIE_NAMES constant"
```

---

## Task 2: chrome-cookies.mjs — listChromeProfiles + 共享常量

**Files:**
- Modify: `tiktok-auth/chrome-cookies.mjs`
- Test: `tiktok-auth/__tests__/chrome-cookies.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试** — 在 `tiktok-auth/__tests__/chrome-cookies.test.mjs` 顶部 import 增加：

```js
import {
  parseLocalStateNames,
  listChromeProfiles,
} from "../chrome-cookies.mjs";
import fsExtra from "fs";
import osExtra from "os";
import pathExtra from "path";
```

并在文件末尾追加：

```js
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
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/chrome-cookies.test.mjs` — FAIL `parseLocalStateNames is not a function`。

- [ ] **Step 3: 实现** — 编辑 `tiktok-auth/chrome-cookies.mjs`：

(a) 顶部 import 增加（在现有 import 之后）：
```js
import { SESSION_COOKIE_NAMES } from "./constants.mjs";
```

(b) 把现有 `function profileHasLogin(dbPath)` 整体替换为（导出 + 用共享常量）：
```js
export function profileHasLogin(dbPath) {
  try {
    const inList = SESSION_COOKIE_NAMES.map((n) => `'${n}'`).join(",");
    const rows = querySqlite(
      dbPath,
      `SELECT count(*) AS n FROM cookies WHERE host_key LIKE '%tiktok.com' AND name IN (${inList});`,
    );
    return rows.length ? Number(rows[0].n) > 0 : false;
  } catch (e) {
    return false;
  }
}
```

(c) 在文件末尾追加：
```js
/** 解析 Chrome `Local State` JSON 的 profile.info_cache -> { "<dir>": { name, email } }；坏 JSON -> {} */
export function parseLocalStateNames(content) {
  try {
    const j = JSON.parse(content);
    const cache = (j && j.profile && j.profile.info_cache) || {};
    const out = {};
    for (const [dir, info] of Object.entries(cache)) {
      out[dir] = {
        name: (info && info.name) || "",
        email: (info && info.user_name) || "",
      };
    }
    return out;
  } catch (e) {
    return {};
  }
}

function defaultReadLocalState(chromeDir) {
  try {
    return fs.readFileSync(path.join(chromeDir, "Local State"), "utf8");
  } catch (e) {
    return "";
  }
}

/**
 * 列出本机 Chrome profile（用于 add 选源 / profile chrome）。
 * 从 Local State 枚举真实 profile 目录（与存在 Cookies 的目录取交集），
 * Local State 不可读时回退扫描 Default + Profile* 目录。探针可注入便于测试。
 */
export function listChromeProfiles({
  chromeDir = chromeBaseDir(),
  hasLogin = profileHasLogin,
  readLocalState = defaultReadLocalState,
} = {}) {
  const names = parseLocalStateNames(readLocalState(chromeDir));
  let dirs = Object.keys(names).filter((d) =>
    fs.existsSync(path.join(chromeDir, d, "Cookies")),
  );
  if (!dirs.length) {
    try {
      dirs = fs
        .readdirSync(chromeDir, { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            (e.name === "Default" || e.name.startsWith("Profile ")),
        )
        .map((e) => e.name)
        .filter((d) => fs.existsSync(path.join(chromeDir, d, "Cookies")));
    } catch (e) {
      dirs = [];
    }
  }
  const out = [];
  for (const d of dirs) {
    try {
      out.push({
        profile: d,
        hasLogin: hasLogin(path.join(chromeDir, d, "Cookies")),
        name: (names[d] && names[d].name) || "",
        email: (names[d] && names[d].email) || "",
      });
    } catch (e) {}
  }
  out.sort((a, b) => a.profile.localeCompare(b.profile));
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过** — 该文件全部用例（原有 9 + 新 3）PASS。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/chrome-cookies.mjs tiktok-auth/__tests__/chrome-cookies.test.mjs
git commit -m "feat(profiles): listChromeProfiles + export profileHasLogin via shared const"
```

---

## Task 3: profile-store.mjs — 安全写 + 基础 CRUD

**Files:**
- Create: `tiktok-auth/profile-store.mjs`
- Test: `tiktok-auth/__tests__/profile-store.test.mjs`

- [ ] **Step 1: 写失败测试** — `tiktok-auth/__tests__/profile-store.test.mjs`:

```js
import fs from "fs";
import os from "os";
import path from "path";
import {
  assertValidName,
  writeProfile,
  readProfile,
  loadProfileCookies,
  profileExists,
  listProfiles,
} from "../profile-store.mjs";

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ttsa-"));
  process.env.TIKTOK_SIG_AUTH_HOME = home;
});
afterEach(() => {
  delete process.env.TIKTOK_SIG_AUTH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const COOKIES = [
  { name: "sessionid", value: "s", domain: ".tiktok.com", path: "/", secure: true, httpOnly: true },
];

describe("assertValidName", () => {
  test("accepts safe names", () => {
    expect(assertValidName("work-1.bak")).toBe("work-1.bak");
  });
  test("rejects traversal / dots / separators", () => {
    for (const bad of ["..", ".", "a/b", "../x", "a b", ""]) {
      expect(() => assertValidName(bad)).toThrow();
    }
  });
});

describe("writeProfile / readProfile", () => {
  test("round-trips cookies + derived meta", () => {
    const meta = writeProfile("work", COOKIES, { origin: "chrome", sourceChromeProfile: "Profile 1" });
    expect(meta.name).toBe("work");
    expect(meta.origin).toBe("chrome");
    expect(meta.sourceChromeProfile).toBe("Profile 1");
    expect(meta.cookieCount).toBe(1);
    expect(meta.hasSession).toBe(true);
    expect(meta.createdAt).toEqual(meta.refreshedAt);

    const { meta: m2, cookies } = readProfile("work");
    expect(cookies).toEqual(COOKIES);
    expect(m2).toEqual(meta);
    expect(loadProfileCookies("work")).toEqual(COOKIES);
    expect(profileExists("work")).toBe(true);
    expect(profileExists("nope")).toBe(false);
  });

  test("second write preserves createdAt, updates refreshedAt", async () => {
    const a = writeProfile("work", COOKIES, {});
    await new Promise((r) => setTimeout(r, 5));
    const b = writeProfile("work", COOKIES, {});
    expect(b.createdAt).toBe(a.createdAt);
    expect(new Date(b.refreshedAt).getTime()).toBeGreaterThanOrEqual(new Date(a.createdAt).getTime());
  });

  test("files are 0600 and dirs 0700 even under loose umask", () => {
    const old = process.umask(0o000);
    try {
      writeProfile("work", COOKIES, {});
    } finally {
      process.umask(old);
    }
    const fmode = (p) => fs.statSync(p).mode & 0o777;
    expect(fmode(path.join(home, "profiles", "work", "cookies.json"))).toBe(0o600);
    expect(fmode(path.join(home, "profiles", "work", "meta.json"))).toBe(0o600);
    expect(fmode(home)).toBe(0o700);
    expect(fmode(path.join(home, "profiles"))).toBe(0o700);
    expect(fmode(path.join(home, "profiles", "work"))).toBe(0o700);
  });

  test("readProfile throws for missing", () => {
    expect(() => readProfile("ghost")).toThrow(/profile not found/);
  });
});

describe("listProfiles", () => {
  test("sorted, skips dirs without meta", () => {
    writeProfile("b", COOKIES, {});
    writeProfile("a", COOKIES, {});
    fs.mkdirSync(path.join(home, "profiles", "junk"), { recursive: true });
    const names = listProfiles().map((p) => p.name);
    expect(names).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — FAIL `Cannot find module '../profile-store.mjs'`。

- [ ] **Step 3: 实现** — `tiktok-auth/profile-store.mjs`:

```js
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { hasSessionCookie } from "./constants.mjs";

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function baseDir() {
  return (
    process.env.TIKTOK_SIG_AUTH_HOME ||
    path.join(os.homedir(), ".tiktok-sig-auth")
  );
}
export function profilesDir() {
  return path.join(baseDir(), "profiles");
}
export function backupsDir() {
  return path.join(baseDir(), "backups");
}
export function profileDir(name) {
  return path.join(profilesDir(), name);
}

export function assertValidName(name) {
  if (typeof name !== "string" || name === "." || name === ".." || !NAME_RE.test(name)) {
    throw new Error(`invalid profile name: ${JSON.stringify(name)}`);
  }
  return name;
}

function assertContained(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c !== p && !c.startsWith(p + path.sep)) {
    throw new Error(`path escapes ${parent}: ${child}`);
  }
}

function assertSafeBase() {
  const b = baseDir();
  if (!path.isAbsolute(b)) {
    throw new Error(`TIKTOK_SIG_AUTH_HOME must be absolute: ${b}`);
  }
  let st;
  try {
    st = fs.lstatSync(b);
  } catch (e) {
    return; // 尚不存在 -> 将被创建
  }
  if (st.isSymbolicLink()) throw new Error(`base dir is a symlink: ${b}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`base dir not owned by current user: ${b}`);
  }
}

/** 创建目录并强制 0700（mode 受 umask 影响，需补 chmod） */
export function secureMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** 原子安全写：同目录临时文件(O_EXCL|O_NOFOLLOW,0600)+fsync+rename，无可读窗口 */
export function secureWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function ensureDirs(...dirs) {
  assertSafeBase();
  secureMkdir(baseDir());
  for (const d of dirs) secureMkdir(d);
}

export function writeProfile(name, cookies, metaIn = {}) {
  assertValidName(name);
  const dir = profileDir(name);
  assertContained(profilesDir(), dir);
  ensureDirs(profilesDir(), dir);

  const metaPath = path.join(dir, "meta.json");
  let createdAt;
  try {
    createdAt = JSON.parse(fs.readFileSync(metaPath, "utf8")).createdAt;
  } catch (e) {}
  const now = new Date().toISOString();
  const meta = {
    name,
    origin: metaIn.origin === "imported" ? "imported" : "chrome",
    sourceChromeProfile: metaIn.sourceChromeProfile ?? null,
    createdAt: createdAt || now,
    refreshedAt: now,
    cookieCount: Array.isArray(cookies) ? cookies.length : 0,
    hasSession: hasSessionCookie(cookies),
  };
  secureWriteFile(path.join(dir, "cookies.json"), JSON.stringify(cookies, null, 2));
  secureWriteFile(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

export function readProfile(name) {
  assertValidName(name);
  const dir = profileDir(name);
  let meta, cookies;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    cookies = JSON.parse(fs.readFileSync(path.join(dir, "cookies.json"), "utf8"));
  } catch (e) {
    throw new Error(`profile not found: ${name}`);
  }
  return { meta, cookies };
}

export function loadProfileCookies(name) {
  return readProfile(name).cookies;
}

export function profileExists(name) {
  try {
    assertValidName(name);
  } catch (e) {
    return false;
  }
  return fs.existsSync(path.join(profileDir(name), "meta.json"));
}

export function listProfiles() {
  let entries = [];
  try {
    entries = fs
      .readdirSync(profilesDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory());
  } catch (e) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(profilesDir(), e.name, "meta.json"), "utf8"),
      );
      out.push({ name: e.name, meta });
    } catch (err) {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS（全部用例）。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/profile-store.mjs tiktok-auth/__tests__/profile-store.test.mjs
git commit -m "feat(profiles): profile-store secure write + CRUD"
```

---

## Task 4: profile-store.mjs — delete / rename / backup

**Files:**
- Modify: `tiktok-auth/profile-store.mjs`
- Test: `tiktok-auth/__tests__/profile-store.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试** — import 增加 `deleteProfile, renameProfile, backupProfile`，并追加：

```js
describe("delete / rename / backup", () => {
  test("deleteProfile removes; missing throws", () => {
    writeProfile("work", COOKIES, {});
    deleteProfile("work");
    expect(profileExists("work")).toBe(false);
    expect(() => deleteProfile("work")).toThrow(/profile not found/);
  });

  test("renameProfile moves dir + updates meta.name; collision throws", () => {
    writeProfile("old", COOKIES, { origin: "chrome", sourceChromeProfile: "Default" });
    renameProfile("old", "new");
    expect(profileExists("old")).toBe(false);
    expect(readProfile("new").meta.name).toBe("new");
    expect(readProfile("new").meta.sourceChromeProfile).toBe("Default");
    writeProfile("other", COOKIES, {});
    expect(() => renameProfile("new", "other")).toThrow(/already exists/);
  });

  test("backupProfile default location writes a 0600 backup file with payload", () => {
    writeProfile("work", COOKIES, { origin: "chrome", sourceChromeProfile: "Default" });
    const dest = backupProfile("work");
    const j = JSON.parse(fs.readFileSync(dest, "utf8"));
    expect(j.type).toBe("tiktok-sig-auth-backup");
    expect(j.cookies).toEqual(COOKIES);
    expect(j.meta.sourceChromeProfile).toBe("Default");
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
  });

  test("backupProfile explicit dest refuses to overwrite", () => {
    writeProfile("work", COOKIES, {});
    const dest = path.join(home, "out", "bk.json");
    backupProfile("work", dest);
    expect(fs.existsSync(dest)).toBe(true);
    expect(() => backupProfile("work", dest)).toThrow(/already exists/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — FAIL `deleteProfile is not a function`。

- [ ] **Step 3: 实现** — 在 `tiktok-auth/profile-store.mjs` 末尾追加：

```js
export function deleteProfile(name) {
  assertValidName(name);
  const dir = profileDir(name);
  assertContained(profilesDir(), dir);
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    throw new Error(`profile not found: ${name}`);
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to delete symlink: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function renameProfile(oldName, newName) {
  assertValidName(oldName);
  assertValidName(newName);
  if (!profileExists(oldName)) throw new Error(`profile not found: ${oldName}`);
  if (profileExists(newName)) throw new Error(`profile already exists: ${newName}`);
  const to = profileDir(newName);
  assertContained(profilesDir(), to);
  fs.renameSync(profileDir(oldName), to);
  const metaPath = path.join(to, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.name = newName;
  secureWriteFile(metaPath, JSON.stringify(meta, null, 2));
}

function backupTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("T", "-");
}

export function backupProfile(name, destPath) {
  const { meta, cookies } = readProfile(name);
  const payload = JSON.stringify(
    {
      type: "tiktok-sig-auth-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      meta,
      cookies,
    },
    null,
    2,
  );
  let dest;
  if (destPath) {
    dest = path.resolve(destPath);
    if (fs.existsSync(dest)) {
      throw new Error(`backup destination already exists: ${dest}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } else {
    ensureDirs(backupsDir());
    dest = path.join(backupsDir(), `${name}-${backupTimestamp()}.json`);
  }
  secureWriteFile(dest, payload);
  return dest;
}
```

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/profile-store.mjs tiktok-auth/__tests__/profile-store.test.mjs
git commit -m "feat(profiles): profile-store delete/rename/backup with guards"
```

---

## Task 5: cookie-import.mjs — parseImportFile

**Files:**
- Create: `tiktok-auth/cookie-import.mjs`
- Test: `tiktok-auth/__tests__/cookie-import.test.mjs`

- [ ] **Step 1: 写失败测试** — `tiktok-auth/__tests__/cookie-import.test.mjs`:

```js
import { parseImportFile } from "../cookie-import.mjs";

describe("parseImportFile - extension JSON array", () => {
  test("maps fields, normalizes sameSite, expirationDate->expires, filters non-tiktok", () => {
    const arr = JSON.stringify([
      { name: "sessionid", value: "s", domain: ".tiktok.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 1700000000.5 },
      { name: "sess2", value: "v", domain: ".tiktok.com", session: true, sameSite: "lax" },
      { name: "junk", value: "j", domain: ".google.com" },
    ]);
    const { cookies, meta } = parseImportFile(arr);
    expect(meta).toBeUndefined();
    expect(cookies).toEqual([
      { name: "sessionid", value: "s", domain: ".tiktok.com", path: "/", secure: true, httpOnly: true, sameSite: "None", expires: 1700000000 },
      { name: "sess2", value: "v", domain: ".tiktok.com", path: "/", secure: false, httpOnly: false, sameSite: "Lax" },
    ]);
  });
  test("no tiktok cookies -> throws", () => {
    expect(() => parseImportFile(JSON.stringify([{ name: "x", domain: ".google.com" }]))).toThrow(/no tiktok/i);
  });
});

describe("parseImportFile - backup object", () => {
  test("returns cookies + sanitized meta (origin/source preserved)", () => {
    const backup = JSON.stringify({
      type: "tiktok-sig-auth-backup",
      cookies: [{ name: "sessionid", value: "s", domain: ".tiktok.com", path: "/", secure: true, httpOnly: true }],
      meta: { origin: "chrome", sourceChromeProfile: "Profile 1", cookieCount: 999 },
    });
    const { cookies, meta } = parseImportFile(backup);
    expect(cookies[0].name).toBe("sessionid");
    expect(meta).toEqual({ origin: "chrome", sourceChromeProfile: "Profile 1" });
  });
});

describe("parseImportFile - safety", () => {
  test("bad JSON throws", () => {
    expect(() => parseImportFile("nope")).toThrow(/valid JSON/i);
  });
  test("unrecognized format throws", () => {
    expect(() => parseImportFile(JSON.stringify({ foo: 1 }))).toThrow(/unrecognized/i);
  });
  test("__proto__ payload does not pollute Object.prototype", () => {
    const evil = JSON.stringify([{ name: "sessionid", domain: ".tiktok.com", __proto__: { polluted: true } }]);
    parseImportFile(evil);
    expect({}.polluted).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — FAIL `Cannot find module '../cookie-import.mjs'`。

- [ ] **Step 3: 实现** — `tiktok-auth/cookie-import.mjs`:

```js
const SAME_SITE = { no_restriction: "None", lax: "Lax", strict: "Strict" };
const DANGER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) {
    if (DANGER_KEYS.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function mapExtensionCookie(c) {
  if (!c || typeof c !== "object") return null;
  const domain = typeof c.domain === "string" ? c.domain : "";
  if (!domain.endsWith("tiktok.com")) return null;
  const out = {
    name: String(c.name ?? ""),
    value: String(c.value ?? ""),
    domain,
    path: typeof c.path === "string" ? c.path : "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  const ss = SAME_SITE[String(c.sameSite || "").toLowerCase()];
  if (ss) out.sameSite = ss;
  if (c.session !== true && typeof c.expirationDate === "number") {
    out.expires = Math.floor(c.expirationDate);
  }
  return out;
}

function sanitizeBackupCookie(c) {
  const o = pick(c, ["name", "value", "domain", "path", "secure", "httpOnly", "expires", "sameSite"]);
  if (!o.name || !o.domain) return null;
  o.secure = !!o.secure;
  o.httpOnly = !!o.httpOnly;
  if (o.path == null) o.path = "/";
  if (o.expires != null && typeof o.expires !== "number") delete o.expires;
  return o;
}

function sanitizeMeta(m) {
  return pick(m, ["origin", "sourceChromeProfile"]);
}

/**
 * 解析导入文件内容（已由调用方做大小上限校验）。
 * 顶层数组 -> 扩展格式 {cookies}；含 cookies 数组的对象 -> 备份格式 {cookies, meta}。
 */
export function parseImportFile(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error("import file is not valid JSON");
  }
  if (Array.isArray(data)) {
    const cookies = data.map(mapExtensionCookie).filter(Boolean);
    if (!cookies.length) throw new Error("no tiktok.com cookies found in import file");
    return { cookies };
  }
  if (data && typeof data === "object" && Array.isArray(data.cookies)) {
    const cookies = data.cookies.map(sanitizeBackupCookie).filter(Boolean);
    if (!cookies.length) throw new Error("backup contains no cookies");
    return { cookies, meta: sanitizeMeta(data.meta) };
  }
  throw new Error("unrecognized import format");
}
```

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/cookie-import.mjs tiktok-auth/__tests__/cookie-import.test.mjs
git commit -m "feat(profiles): cookie-import parser (extension + backup, hardened)"
```

---

## Task 6: parse-args.mjs + auth-server.mjs --profile

**Files:**
- Create: `tiktok-auth/parse-args.mjs`
- Modify: `auth-server.mjs`
- Test: `tiktok-auth/__tests__/parse-args.test.mjs`

- [ ] **Step 1: 写失败测试** — `tiktok-auth/__tests__/parse-args.test.mjs`:

```js
import { parseProfileArg } from "../parse-args.mjs";

describe("parseProfileArg", () => {
  test("--profile <name>", () => {
    expect(parseProfileArg(["--profile", "work"])).toBe("work");
  });
  test("--profile=<name>", () => {
    expect(parseProfileArg(["--profile=play"])).toBe("play");
  });
  test("absent -> undefined", () => {
    expect(parseProfileArg(["--other", "x"])).toBeUndefined();
    expect(parseProfileArg([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — FAIL `Cannot find module '../parse-args.mjs'`。

- [ ] **Step 3a: 实现 parse-args.mjs** — `tiktok-auth/parse-args.mjs`:

```js
/** 从 argv 解析 --profile <name> / --profile=<name>；无则 undefined */
export function parseProfileArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") return argv[i + 1];
    if (a.startsWith("--profile=")) return a.slice("--profile=".length);
  }
  return undefined;
}
```

- [ ] **Step 3b: 改 auth-server.mjs** — 替换其 import 块与安装前逻辑。把现有第 7-15 行：

```js
import puppeteer from "puppeteer-extra";
import { installAuthHook } from "./tiktok-auth/index.mjs";

let installed = false;
try {
  installed = await installAuthHook(puppeteer);
} catch (e) {
  console.warn(`[auth] 钩子安装失败，回退匿名模式：${e.message}`);
}
```

替换为：

```js
import puppeteer from "puppeteer-extra";
import { installAuthHook } from "./tiktok-auth/index.mjs";
import { parseProfileArg } from "./tiktok-auth/parse-args.mjs";

const profileArg = parseProfileArg(process.argv.slice(2));
if (profileArg) process.env.TIKTOK_PROFILE = profileArg;

let installed = false;
try {
  installed = await installAuthHook(puppeteer);
} catch (e) {
  console.warn(`[auth] 钩子安装失败，回退匿名模式：${e.message}`);
}
```

- [ ] **Step 4: 跑测试确认通过** — Run parse-args.test.mjs → PASS。并跑 launcher.test.mjs（验证 auth-server 结构测试仍过，`installAuthHook(` 仍在 `import("./server.mjs")` 之前）。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/parse-args.mjs auth-server.mjs tiktok-auth/__tests__/parse-args.test.mjs
git commit -m "feat(profiles): auth-server --profile -> TIKTOK_PROFILE (testable parser)"
```

---

## Task 7: index.mjs — getConfiguredCookies（修签名冲突）

**Files:**
- Modify: `tiktok-auth/index.mjs`
- Test: `tiktok-auth/__tests__/launcher.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试** — 在 `tiktok-auth/__tests__/launcher.test.mjs` 顶部 import 增加：

```js
import { installAuthHook, getConfiguredCookies } from "../index.mjs";
```
（替换原来的 `import { installAuthHook } from "../index.mjs";`）

并追加：

```js
describe("hook calls getCookies with NO args (signature-collision guard)", () => {
  test("getCookies invoked with zero arguments", async () => {
    const events = [];
    const pptr = makeFakePuppeteer(events);
    let argsSeen = "unset";
    await installAuthHook(pptr, {
      enabled: true,
      getCookies: async (...a) => {
        argsSeen = a;
        return [];
      },
    });
    const b = await pptr.launch();
    await b.newPage();
    expect(argsSeen).toEqual([]);
  });
});

describe("getConfiguredCookies dispatch", () => {
  afterEach(() => {
    delete process.env.TIKTOK_PROFILE;
    delete process.env.CHROME_PROFILE;
  });
  test("uses store loader when TIKTOK_PROFILE set", async () => {
    process.env.TIKTOK_PROFILE = "work";
    const calls = [];
    const deps = {
      loadProfileCookies: async (n) => { calls.push(["store", n]); return [{ name: "sessionid" }]; },
      getChromeTikTokCookies: async (o) => { calls.push(["chrome", o]); return []; },
    };
    const r = await getConfiguredCookies(deps);
    expect(calls).toEqual([["store", "work"]]);
    expect(r).toEqual([{ name: "sessionid" }]);
  });
  test("falls back to chrome live when TIKTOK_PROFILE unset", async () => {
    process.env.CHROME_PROFILE = "Profile 1";
    const calls = [];
    const deps = {
      loadProfileCookies: async () => { calls.push("store"); return []; },
      getChromeTikTokCookies: async (o) => { calls.push(["chrome", o]); return []; },
    };
    await getConfiguredCookies(deps);
    expect(calls).toEqual([["chrome", { profile: "Profile 1" }]]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run launcher.test.mjs → FAIL（`getConfiguredCookies` 未导出 / `argsSeen` 期望 `[]` 但当前钩子传了 `{profile:...}`）。

- [ ] **Step 3: 实现** — 编辑 `tiktok-auth/index.mjs`：

(a) 顶部 import 块替换为：
```js
import { getChromeTikTokCookies } from "./chrome-cookies.mjs";
import { loadProfileCookies } from "./profile-store.mjs";
import { SESSION_COOKIE_NAMES } from "./constants.mjs";

const realDeps = { loadProfileCookies, getChromeTikTokCookies };

/** 决定注入源：TIKTOK_PROFILE -> 读存储；否则 CHROME_PROFILE -> 实时回退。deps 可注入便于测试。 */
export async function getConfiguredCookies(deps = realDeps) {
  if (process.env.TIKTOK_PROFILE) {
    return deps.loadProfileCookies(process.env.TIKTOK_PROFILE);
  }
  return deps.getChromeTikTokCookies({ profile: process.env.CHROME_PROFILE });
}
```

(b) 把 `const getCookies = options.getCookies || getChromeTikTokCookies;` 改为：
```js
  const getCookies = options.getCookies || getConfiguredCookies;
```

(c) 把 `const cookies = await getCookies({ profile: process.env.CHROME_PROFILE });` 改为（无参）：
```js
        const cookies = await getCookies();
```

(d) 把 `const loggedIn = cookies.some((c) => c.name === "sessionid");` 改为：
```js
          const loggedIn = cookies.some((c) => SESSION_COOKIE_NAMES.includes(c.name));
```

- [ ] **Step 4: 跑测试确认通过** — Run launcher.test.mjs → PASS（原 3 + auth-server 结构 2 + 新 3 = 8）。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/index.mjs tiktok-auth/__tests__/launcher.test.mjs
git commit -m "fix(profiles): getConfiguredCookies + no-arg getCookies (signature-collision fix)"
```

---

## Task 8: profile-cli.mjs — 核心 run() + list/chrome/exists/ps-profile

**Files:**
- Create: `tiktok-auth/profile-cli.mjs`
- Test: `tiktok-auth/__tests__/cli.test.mjs`

- [ ] **Step 1: 写失败测试** — `tiktok-auth/__tests__/cli.test.mjs`:

```js
import { run } from "../profile-cli.mjs";

function makeDeps(over = {}) {
  return {
    store: {
      listProfiles: () => [],
      profileExists: () => false,
      ...(over.store || {}),
    },
    listChromeProfiles: () => [],
    isTTY: false,
    prompt: async () => "",
    readFile: () => "",
    statFile: () => ({ size: 0 }),
    ...over,
  };
}

describe("run routing", () => {
  test("unknown command -> code 2 + usage", async () => {
    const r = await run(["bogus"], makeDeps());
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });

  test("list --porcelain prints TSV rows, no header", async () => {
    const deps = makeDeps({
      store: {
        listProfiles: () => [
          { name: "work", meta: { origin: "chrome", sourceChromeProfile: "Profile 1", refreshedAt: "2026-06-16T00:00:00.000Z", hasSession: true } },
          { name: "play", meta: { origin: "imported", sourceChromeProfile: null, refreshedAt: "2026-06-16T00:00:00.000Z", hasSession: false } },
        ],
      },
    });
    const r = await run(["list", "--porcelain"], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "work\tchrome\tProfile 1\t2026-06-16T00:00:00.000Z\ttrue\n" +
        "play\timported\t\t2026-06-16T00:00:00.000Z\tfalse\n",
    );
  });

  test("chrome --porcelain prints profile rows", async () => {
    const deps = makeDeps({
      listChromeProfiles: () => [{ profile: "Default", hasLogin: true, name: "Me", email: "m@x.com" }],
    });
    const r = await run(["chrome", "--porcelain"], deps);
    expect(r.stdout).toBe("Default\tMe\tm@x.com\ttrue\n");
  });

  test("exists -> 0 if present, 2 if not", async () => {
    expect((await run(["exists", "work"], makeDeps({ store: { profileExists: (n) => n === "work" } }))).code).toBe(0);
    expect((await run(["exists", "ghost"], makeDeps({ store: { profileExists: () => false } }))).code).toBe(2);
  });

  test("ps-profile extracts --profile token", async () => {
    // run() returns the raw name; the shim adds the trailing newline for bash.
    const r = await run(["ps-profile", "node --env-file auth-server.mjs --profile work"], makeDeps());
    expect(r.stdout).toBe("work");
    const r2 = await run(["ps-profile", "node auth-server.mjs"], makeDeps());
    expect(r2.stdout).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — FAIL `Cannot find module '../profile-cli.mjs'`。

- [ ] **Step 3: 实现** — `tiktok-auth/profile-cli.mjs`:

```js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as store from "./profile-store.mjs";
import { parseImportFile } from "./cookie-import.mjs";
import { listChromeProfiles } from "./chrome-cookies.mjs";
import { getChromeTikTokCookies } from "./chrome-cookies.mjs";

const USAGE =
  "usage: profile-cli <list|chrome|add|refresh|rename|delete|backup|import|restore|exists|pick-start|ps-profile> [...]";

function ok(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}
function userErr(stderr) {
  return { code: 2, stdout: "", stderr };
}
function hasFlag(rest, f) {
  return rest.includes(f);
}
function positionals(rest) {
  return rest.filter((a) => !a.startsWith("--"));
}
function flagVal(rest, name) {
  const eq = rest.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

function cmdList(rest, deps) {
  const rows = deps.store.listProfiles();
  if (hasFlag(rest, "--porcelain")) {
    return ok(
      rows
        .map((p) =>
          [p.name, p.meta.origin, p.meta.sourceChromeProfile || "", p.meta.refreshedAt, String(!!p.meta.hasSession)].join("\t"),
        )
        .map((l) => l + "\n")
        .join(""),
    );
  }
  if (!rows.length) return ok("(no saved profiles; run `profile add`)");
  return ok(
    rows
      .map((p) => `${p.name}\t[${p.meta.origin}${p.meta.sourceChromeProfile ? " " + p.meta.sourceChromeProfile : ""}]\t${p.meta.refreshedAt}\t${p.meta.hasSession ? "✅" : "❌"}`)
      .join("\n"),
  );
}

function cmdChrome(rest, deps) {
  const rows = deps.listChromeProfiles();
  if (hasFlag(rest, "--porcelain")) {
    return ok(
      rows.map((p) => [p.profile, p.name, p.email, String(!!p.hasLogin)].join("\t") + "\n").join(""),
    );
  }
  if (!rows.length) return ok("(no Chrome profiles found)");
  return ok(
    rows.map((p) => `${p.profile}\t${p.name}${p.email ? " (" + p.email + ")" : ""}\t${p.hasLogin ? "✅已登录" : "—"}`).join("\n"),
  );
}

function cmdExists(rest, deps) {
  const [name] = positionals(rest);
  if (!name) return userErr("exists: name required");
  return deps.store.profileExists(name) ? ok("") : userErr(`profile not found: ${name}`);
}

function cmdPsProfile(rest) {
  const cmdline = rest.join(" ");
  const m = cmdline.match(/--profile[= ]+("([^"]*)"|'([^']*)'|(\S+))/);
  const name = m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
  return ok(name);
}

export async function run(argv, deps) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "list": return cmdList(rest, deps);
      case "chrome": return cmdChrome(rest, deps);
      case "exists": return cmdExists(rest, deps);
      case "ps-profile": return cmdPsProfile(rest);
      default: return { code: 2, stdout: "", stderr: USAGE };
    }
  } catch (e) {
    return { code: 1, stdout: "", stderr: `error: ${e.message}` };
  }
}

function makeRealDeps() {
  return {
    store,
    importer: { parseImportFile },
    listChromeProfiles,
    getChromeTikTokCookies,
    isTTY: !!process.stdin.isTTY,
    prompt: async () => "",
    readFile: (p) => fs.readFileSync(p, "utf8"),
    statFile: (p) => fs.statSync(p),
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run(process.argv.slice(2), makeRealDeps()).then(({ code, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : stdout + "\n");
    if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : stderr + "\n");
    process.exit(code);
  });
}
```

注：`deps.store` 在测试里是假对象；`makeRealDeps` 用真实 `store` 模块（命名空间导入）。`cmdExists`/`cmdList` 经 `deps.store`，`cmdChrome` 经 `deps.listChromeProfiles`。

- [ ] **Step 4: 跑测试确认通过** — Run: `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/cli.test.mjs` → PASS。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/profile-cli.mjs tiktok-auth/__tests__/cli.test.mjs
git commit -m "feat(profiles): profile-cli core + list/chrome/exists/ps-profile"
```

---

## Task 9: profile-cli.mjs — add / refresh

**Files:**
- Modify: `tiktok-auth/profile-cli.mjs`
- Test: `tiktok-auth/__tests__/cli.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**：

```js
describe("add / refresh", () => {
  function depsWith(over) {
    const saved = {};
    const base = makeDeps({
      store: {
        profileExists: (n) => Object.prototype.hasOwnProperty.call(saved, n),
        writeProfile: (n, cookies, meta) => { saved[n] = { cookies, meta }; return { name: n, ...meta }; },
        readProfile: (n) => { if (!saved[n]) throw new Error(`profile not found: ${n}`); return { meta: { name: n, ...saved[n].meta }, cookies: saved[n].cookies }; },
      },
      listChromeProfiles: () => [{ profile: "Profile 1" }, { profile: "Default" }],
      getChromeTikTokCookies: async () => [{ name: "sessionid", value: "s", domain: ".tiktok.com" }],
      ...over,
    });
    base.__saved = saved;
    return base;
  }

  test("add <name> --from <chrome> extracts + saves", async () => {
    const deps = depsWith();
    const r = await run(["add", "work", "--from", "Profile 1"], deps);
    expect(r.code).toBe(0);
    expect(deps.__saved.work.meta).toMatchObject({ origin: "chrome", sourceChromeProfile: "Profile 1" });
    expect(deps.__saved.work.cookies[0].name).toBe("sessionid");
  });

  test("add existing name without --force -> 2", async () => {
    const deps = depsWith();
    await run(["add", "work", "--from", "Default"], deps);
    const r = await run(["add", "work", "--from", "Default"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/exists/i);
  });

  test("add --from with no extracted cookies -> 2", async () => {
    const deps = depsWith({ getChromeTikTokCookies: async () => [] });
    const r = await run(["add", "work", "--from", "Default"], deps);
    expect(r.code).toBe(2);
  });

  test("refresh imported (no source) -> 2", async () => {
    const deps = depsWith();
    deps.__saved.imp = { cookies: [], meta: { origin: "imported", sourceChromeProfile: null } };
    const r = await run(["refresh", "imp"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/source/i);
  });

  test("refresh re-extracts from source", async () => {
    const deps = depsWith();
    await run(["add", "work", "--from", "Profile 1"], deps);
    const r = await run(["refresh", "work"], deps);
    expect(r.code).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `add`/`refresh` 未实现 → 命中 default 分支返回 2 但 stderr 是 USAGE，断言 `origin` 等失败。

- [ ] **Step 3: 实现** — 在 `profile-cli.mjs` 增加两个命令函数并接进 switch：

(a) 在 `run` 的 switch 增加：
```js
      case "add": return await cmdAdd(rest, deps);
      case "refresh": return await cmdRefresh(rest, deps);
```

(b) 在 `run` 定义前增加：
```js
async function cmdAdd(rest, deps) {
  let name = positionals(rest)[0];
  let from = flagVal(rest, "--from");
  const force = hasFlag(rest, "--force");
  if ((!name || !from) && deps.isTTY) {
    const picked = await interactiveAdd(deps);
    if (!picked) return userErr("add: cancelled");
    name = name || picked.name;
    from = from || picked.from;
  }
  if (!name) return userErr("add: name required");
  if (!from) return userErr("add: --from <chromeProfile> required");
  if (deps.store.profileExists(name) && !force) {
    return userErr(`profile already exists: ${name} (use --force or refresh)`);
  }
  const available = deps.listChromeProfiles();
  if (!available.some((p) => p.profile === from)) {
    return userErr(`Chrome profile not found / no Cookies: ${from}`);
  }
  const cookies = await deps.getChromeTikTokCookies({ profile: from });
  if (!cookies || !cookies.length) {
    return userErr(`no cookies extracted from Chrome profile: ${from}`);
  }
  const meta = deps.store.writeProfile(name, cookies, { origin: "chrome", sourceChromeProfile: from });
  const warn = meta.hasSession ? "" : "\n[warn] 提取结果不含 sessionid（该 Chrome profile 可能未登录）";
  return ok(`saved profile '${name}' from Chrome '${from}' (${cookies.length} cookies)${warn}`);
}

async function interactiveAdd(deps) {
  const rows = deps.listChromeProfiles();
  if (!rows.length) return null;
  const lines = rows.map((p, i) => `${i + 1}) ${p.profile}  ${p.name}${p.email ? " (" + p.email + ")" : ""}  ${p.hasLogin ? "✅" : "—"}`);
  const sel = await deps.prompt(`选择要提取的 Chrome profile:\n${lines.join("\n")}\n序号: `);
  const idx = Number(sel) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) return null;
  const name = (await deps.prompt("给这个账号起个名字: ")).trim();
  if (!name) return null;
  return { name, from: rows[idx].profile };
}

async function cmdRefresh(rest, deps) {
  const name = positionals(rest)[0];
  const force = hasFlag(rest, "--force");
  if (!name) return userErr("refresh: name required");
  let meta;
  try {
    meta = deps.store.readProfile(name).meta;
  } catch (e) {
    return userErr(`profile not found: ${name}`);
  }
  if (!meta.sourceChromeProfile) {
    return userErr(`profile '${name}' has no Chrome source to refresh from (imported)`);
  }
  const cookies = await deps.getChromeTikTokCookies({ profile: meta.sourceChromeProfile });
  const fresh = cookies && cookies.some((c) => c.name === "sessionid");
  if (!fresh && !force) {
    return userErr(`refresh got no sessionid for '${name}'; kept existing session (use --force to overwrite)`);
  }
  deps.store.writeProfile(name, cookies, { origin: "chrome", sourceChromeProfile: meta.sourceChromeProfile });
  return ok(`refreshed '${name}' from Chrome '${meta.sourceChromeProfile}' (${cookies.length} cookies)`);
}
```

(c) `makeRealDeps` 已含 `getChromeTikTokCookies` 与 `prompt`（Task 10 会把 prompt 换成真实 readline）。

- [ ] **Step 4: 跑测试确认通过** — Run cli.test.mjs → PASS。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/profile-cli.mjs tiktok-auth/__tests__/cli.test.mjs
git commit -m "feat(profiles): profile-cli add/refresh"
```

---

## Task 10: profile-cli.mjs — rename/delete/backup/import/pick-start + 真实 prompt

**Files:**
- Modify: `tiktok-auth/profile-cli.mjs`
- Test: `tiktok-auth/__tests__/cli.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**：

```js
describe("rename / delete / backup / import / pick-start", () => {
  function storeMock(initial = {}) {
    const saved = { ...initial };
    return {
      saved,
      profileExists: (n) => Object.prototype.hasOwnProperty.call(saved, n),
      writeProfile: (n, cookies, meta) => { saved[n] = { cookies, meta }; return { name: n, ...meta }; },
      readProfile: (n) => { if (!saved[n]) throw new Error("nf"); return { meta: { name: n, ...(saved[n].meta || {}) }, cookies: saved[n].cookies || [] }; },
      listProfiles: () => Object.keys(saved).sort().map((n) => ({ name: n, meta: { origin: "chrome", sourceChromeProfile: "x", refreshedAt: "t", hasSession: true, ...(saved[n].meta || {}) } })),
      renameProfile: (o, x) => { if (saved[x]) throw new Error("already exists"); saved[x] = saved[o]; delete saved[o]; },
      deleteProfile: (n) => { if (!saved[n]) throw new Error("profile not found"); delete saved[n]; },
      backupProfile: (n, dest) => dest || `/bk/${n}.json`,
    };
  }

  test("rename ok; collision -> 2", async () => {
    const store = storeMock({ a: { cookies: [] }, b: { cookies: [] } });
    expect((await run(["rename", "a", "c"], makeDeps({ store }))).code).toBe(0);
    expect(store.saved.c).toBeDefined();
    expect((await run(["rename", "c", "b"], makeDeps({ store }))).code).toBe(2);
  });

  test("delete with --yes (non-interactive)", async () => {
    const store = storeMock({ a: { cookies: [] } });
    expect((await run(["delete", "a", "--yes"], makeDeps({ store, isTTY: false }))).code).toBe(0);
    expect(store.saved.a).toBeUndefined();
  });

  test("backup prints dest", async () => {
    const store = storeMock({ a: { cookies: [] } });
    const r = await run(["backup", "a"], makeDeps({ store }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.json/);
  });

  test("import extension without name -> 2", async () => {
    const deps = makeDeps({
      store: storeMock(),
      importer: { parseImportFile: () => ({ cookies: [{ name: "sessionid", domain: ".tiktok.com" }] }) },
      readFile: () => "[]",
      statFile: () => ({ size: 10 }),
    });
    const r = await run(["import", "/tmp/x.json"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/name/i);
  });

  test("import backup uses meta.name, preserves origin/source", async () => {
    const store = storeMock();
    const deps = makeDeps({
      store,
      importer: { parseImportFile: () => ({ cookies: [{ name: "sessionid", domain: ".tiktok.com" }], meta: { origin: "chrome", sourceChromeProfile: "Profile 1" } }) },
      readFile: () => "{}",
      statFile: () => ({ size: 10 }),
    });
    const r = await run(["import", "/tmp/bk.json"], deps);
    expect(r.code).toBe(0);
    // name 缺省时无 meta.name -> 报错；这里 parseImportFile 未给 name，故走 arg。改测带 name：
  });

  test("import oversize -> 2", async () => {
    const deps = makeDeps({ store: storeMock(), readFile: () => "[]", statFile: () => ({ size: 6 * 1024 * 1024 }) });
    const r = await run(["import", "/tmp/big.json", "work"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/too large|size/i);
  });

  test("pick-start: empty store -> non-zero, empty stdout", async () => {
    const r = await run(["pick-start"], makeDeps({ store: storeMock(), isTTY: true }));
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  test("pick-start: prints chosen name only on stdout", async () => {
    const store = storeMock({ work: { cookies: [] }, play: { cookies: [] } });
    const deps = makeDeps({ store, isTTY: true, prompt: async () => "2" });
    const r = await run(["pick-start"], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("work"); // 排序后 [play, work] 的第 2 个是 work；run() 不带换行
  });
});
```

注：把上面 "import backup uses meta.name" 用例改为带显式 name 以保持确定性：

```js
  test("import backup with explicit name preserves origin/source", async () => {
    const store = storeMock();
    const deps = makeDeps({
      store,
      importer: { parseImportFile: () => ({ cookies: [{ name: "sessionid", domain: ".tiktok.com" }], meta: { origin: "chrome", sourceChromeProfile: "Profile 1" } }) },
      readFile: () => "{}",
      statFile: () => ({ size: 10 }),
    });
    const r = await run(["import", "/tmp/bk.json", "restored"], deps);
    expect(r.code).toBe(0);
    expect(store.saved.restored.meta).toMatchObject({ origin: "chrome", sourceChromeProfile: "Profile 1" });
  });
```
（删除前一个占位的 "import backup uses meta.name" 用例。）

- [ ] **Step 2: 跑测试确认失败** — 相关命令未实现。

- [ ] **Step 3: 实现** — 在 `profile-cli.mjs` 的 switch 增加：
```js
      case "rename": return cmdRename(rest, deps);
      case "delete": return await cmdDelete(rest, deps);
      case "backup": return cmdBackup(rest, deps);
      case "import":
      case "restore": return cmdImport(rest, deps);
      case "pick-start": return await cmdPickStart(rest, deps);
```

并增加命令实现（放在 `run` 定义之前）：
```js
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

function cmdRename(rest, deps) {
  const [oldName, newName] = positionals(rest);
  if (!oldName || !newName) return userErr("rename: <old> <new> required");
  try {
    deps.store.renameProfile(oldName, newName);
  } catch (e) {
    return userErr(e.message);
  }
  return ok(`renamed '${oldName}' -> '${newName}'`);
}

async function cmdDelete(rest, deps) {
  const name = positionals(rest)[0];
  if (!name) return userErr("delete: name required");
  if (!deps.store.profileExists(name)) return userErr(`profile not found: ${name}`);
  if (deps.isTTY && !hasFlag(rest, "--yes")) {
    const yn = (await deps.prompt(`确认删除 '${name}'? [y/N] `)).trim().toLowerCase();
    if (yn !== "y" && yn !== "yes") return ok("cancelled");
  }
  try {
    deps.store.deleteProfile(name);
  } catch (e) {
    return userErr(e.message);
  }
  return ok(`deleted '${name}'`);
}

function cmdBackup(rest, deps) {
  const [name, dest] = positionals(rest);
  if (!name) return userErr("backup: name required");
  let out;
  try {
    out = deps.store.backupProfile(name, dest);
  } catch (e) {
    return userErr(e.message);
  }
  const warn = insideGitTree(out) ? "\n[warn] 备份落在 git 工作树内，注意勿提交（含凭据）" : "";
  return ok(`backed up '${name}' -> ${out}${warn}`);
}

function insideGitTree(p) {
  let d = path.dirname(path.resolve(p));
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return false;
}

function cmdImport(rest, deps) {
  const [file, nameArg] = positionals(rest);
  const force = hasFlag(rest, "--force");
  if (!file) return userErr("import: <file> required");
  let size;
  try {
    size = deps.statFile(file).size;
  } catch (e) {
    return userErr(`cannot read import file: ${file}`);
  }
  if (size > MAX_IMPORT_BYTES) return userErr(`import file too large (> ${MAX_IMPORT_BYTES} bytes)`);
  let parsed;
  try {
    parsed = deps.importer.parseImportFile(deps.readFile(file));
  } catch (e) {
    return userErr(e.message);
  }
  const name = nameArg || (parsed.meta && parsed.meta.name);
  if (!name) return userErr("import: name required for this file (extension export has no name)");
  if (deps.store.profileExists(name) && !force) {
    return userErr(`profile already exists: ${name} (use --force)`);
  }
  const metaIn = parsed.meta
    ? { origin: parsed.meta.origin || "imported", sourceChromeProfile: parsed.meta.sourceChromeProfile ?? null }
    : { origin: "imported", sourceChromeProfile: null };
  const meta = deps.store.writeProfile(name, parsed.cookies, metaIn);
  const warn = meta.hasSession ? "" : "\n[warn] 导入内容不含 sessionid";
  return ok(`imported profile '${name}' (${parsed.cookies.length} cookies)${warn}`);
}

async function cmdPickStart(rest, deps) {
  const rows = deps.store.listProfiles();
  if (!rows.length) {
    return { code: 2, stdout: "", stderr: "no saved profiles; run `profile add` first" };
  }
  if (!deps.isTTY) {
    return { code: 2, stdout: "", stderr: "no TTY for interactive selection; pass a profile name to start" };
  }
  const lines = rows.map((p, i) => `${i + 1}) ${p.name}  [${p.meta.origin}]  ${p.meta.hasSession ? "✅" : "❌"}  ${p.meta.refreshedAt}`);
  const sel = await deps.prompt(`选择要启动的账号:\n${lines.join("\n")}\n序号: `);
  const idx = Number(sel) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) {
    return { code: 2, stdout: "", stderr: "cancelled / invalid selection" };
  }
  return { code: 0, stdout: rows[idx].name, stderr: "" };
}
```

并把 `makeRealDeps` 的 `prompt` 换成真实 readline：
```js
import readline from "readline";
// ...
function realPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}
```
并在 `makeRealDeps` 中 `prompt: realPrompt`。（提示走 stderr，保证 pick-start 的 stdout 只含结果名。）

- [ ] **Step 4: 跑测试确认通过** — Run cli.test.mjs → PASS（全部）。同时 `node --experimental-vm-modules node_modules/.bin/jest` 全量通过。
- [ ] **Step 5: 提交**

```bash
git add tiktok-auth/profile-cli.mjs tiktok-auth/__tests__/cli.test.mjs
git commit -m "feat(profiles): profile-cli rename/delete/backup/import/pick-start"
```

---

## Task 11: tiktokctl.sh — profile 透传 + start[name] + status/restart 解析

**Files:**
- Modify: `tiktokctl.sh`

- [ ] **Step 1: 实现** — 用以下完整内容替换 `tiktokctl.sh`：

```bash
#!/usr/bin/env bash
# TikTok 签名服务（多账号登录态版）进程管理。附加脚本，不触碰上游文件。
# 服务: start [name] | stop | restart [name] | status | log
# 账号: profile <list|chrome|add|refresh|rename|delete|backup|import|restore> ...
set -uo pipefail

cd "$(dirname "$0")"

ENTRY="auth-server.mjs"
CLI="tiktok-auth/profile-cli.mjs"
PID_FILE="tiktok-auth/auth-server.pid"
LOG_FILE="tiktok-auth/auth-server.log"

PORT=8080
if [ -f .env ]; then
  envport="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | tr -d '[:space:]' || true)"
  [ -n "${envport:-}" ] && PORT="$envport"
fi

env_value() { # $1=KEY -> value from .env (no inline comment)
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | tr -d '[:space:]' || true
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

running_profile() { # echo current --profile from live pid (empty if none)
  is_running || return 0
  local pid cmd
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  node "$CLI" ps-profile "$cmd" 2>/dev/null || true
}

launch() { # $1=profile (may be empty -> legacy CHROME_PROFILE path)
  local prof="$1"
  if [ -n "${TIKTOKCTL_DRY_RUN:-}" ]; then
    if [ -n "$prof" ]; then
      echo "DRY: nohup node --env-file-if-exists=.env $ENTRY --profile $prof"
    else
      echo "DRY: nohup node --env-file-if-exists=.env $ENTRY"
    fi
    return 0
  fi
  mkdir -p "$(dirname "$PID_FILE")"
  if [ -n "$prof" ]; then
    nohup node --env-file-if-exists=.env "$ENTRY" --profile "$prof" >> "$LOG_FILE" 2>&1 &
  else
    nohup node --env-file-if-exists=.env "$ENTRY" >> "$LOG_FILE" 2>&1 &
  fi
  echo "$!" > "$PID_FILE"
  sleep 1
  if is_running; then
    echo "started (pid $(cat "$PID_FILE"))${prof:+ as $prof}, logs -> $LOG_FILE"
  else
    echo "failed to start; see $LOG_FILE"
    return 1
  fi
}

resolve_start_profile() { # echo chosen profile name, or empty for legacy; nonzero on hard error
  local arg="${1:-}"
  if [ -n "$arg" ]; then
    if node "$CLI" exists "$arg" >/dev/null 2>&1; then echo "$arg"; return 0; fi
    echo "" ; return 9
  fi
  if [ -t 0 ] && [ -t 1 ]; then
    local picked
    picked="$(node "$CLI" pick-start)" || return $?
    [ -n "$picked" ] || return 9
    echo "$picked"; return 0
  fi
  # 非交互回退
  local p
  p="$(env_value TIKTOK_PROFILE)"; [ -n "$p" ] && { echo "$p"; return 0; }
  p="$(env_value CHROME_PROFILE)"; [ -n "$p" ] && { echo ""; return 0; }  # legacy live, 不传 --profile
  return 9
}

start() {
  local arg="${1:-}"
  if is_running; then
    local cur; cur="$(running_profile)"
    if [ -n "$arg" ] && [ "$arg" != "$cur" ]; then
      echo "already running as ${cur:-?} (pid $(cat "$PID_FILE")); use 'restart $arg' to switch"
      return 4
    fi
    echo "already running${cur:+ as $cur} (pid $(cat "$PID_FILE"))"
    return 0
  fi
  local prof rc
  prof="$(resolve_start_profile "$arg")"; rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ -n "$arg" ]; then echo "profile not found: $arg"; node "$CLI" list || true
    else echo "no profile selected; run './tiktokctl.sh profile add' first"; fi
    return 2
  fi
  launch "$prof"
}

stop() {
  if ! is_running; then echo "not running"; rm -f "$PID_FILE"; return 0; fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then rm -f "$PID_FILE"; echo "not running"; return 0; fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then echo "graceful stop timed out, sending SIGKILL"; kill -9 "$pid" 2>/dev/null || true; fi
  rm -f "$PID_FILE"
  echo "stopped"
}

restart() {
  local arg="${1:-}" target
  if [ -n "$arg" ]; then
    target="$arg"
  elif is_running; then
    target="$(running_profile)"
    [ -n "$target" ] || target="$(env_value TIKTOK_PROFILE)"
    [ -n "$target" ] || { if [ -n "$(env_value CHROME_PROFILE)" ]; then target="__legacy__"; fi; }
  else
    target="$(env_value TIKTOK_PROFILE)"
  fi
  if [ -z "$target" ]; then
    echo "restart: cannot resolve which profile to restart; not stopping. Pass a name."
    return 2
  fi
  stop
  if [ "$target" = "__legacy__" ]; then start; else start "$target"; fi
}

status() {
  if is_running; then
    local cur; cur="$(running_profile)"
    [ -n "$cur" ] || cur="$(env_value TIKTOK_PROFILE)"
    [ -n "$cur" ] || cur="$(env_value CHROME_PROFILE)"
    echo "running (pid $(cat "$PID_FILE")) on port $PORT${cur:+ — account: $cur}"
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
  start) shift; start "${1:-}" ;;
  stop) stop ;;
  restart) shift; restart "${1:-}" ;;
  status) status ;;
  log | logs) log ;;
  profile) shift; exec node "$CLI" "$@" ;;
  *) echo "usage: $0 {start [name]|stop|restart [name]|status|log|profile <sub> ...}"; exit 2 ;;
esac
```

- [ ] **Step 2: 语法检查 + DRY_RUN 冒烟**

Run:
```bash
cd /Users/nickma/Develop/TikTok/tiktok-signature
bash -n tiktokctl.sh && echo "SYNTAX OK"
./tiktokctl.sh 2>&1 | head -1
TIKTOKCTL_DRY_RUN=1 ./tiktokctl.sh start nonexistent_profile_xyz; echo "rc=$?"
```
Expected: `SYNTAX OK`; usage 行含 `start [name]`；最后一条因 profile 不存在 → 打印 `profile not found: ...` + 列表，`rc=2`（DRY_RUN 不影响 resolve 阶段的存在性校验）。

- [ ] **Step 3: ps-profile 透传冒烟**

Run: `./tiktokctl.sh profile ps-profile "node auth-server.mjs --profile work"`
Expected: 打印 `work`。

- [ ] **Step 4: 提交**

```bash
git add tiktokctl.sh
git commit -m "feat(profiles): tiktokctl multi-account start/status/restart + profile passthrough"
```

---

## Task 12: README 更新

**Files:**
- Modify: `tiktok-auth/README.md`

- [ ] **Step 1: 在 `tiktok-auth/README.md` 末尾追加章节**：

```markdown
## 多账号管理（profile）

每个 TikTok 账号对应一个 Chrome profile。把账号会话提取并持久化到 `~/.tiktok-sig-auth/`（仓库外，文件 0600），启动时选择加载哪个。

```bash
# 列出本机 Chrome profile（看哪个登录了 TikTok）
./tiktokctl.sh profile chrome

# 提取保存一个账号（交互选 Chrome profile + 起名；或直接指定）
./tiktokctl.sh profile add work --from "Profile 1"

# 管理
./tiktokctl.sh profile list
./tiktokctl.sh profile refresh work       # 从来源 Chrome profile 重新提取（弹钥匙串）
./tiktokctl.sh profile rename work work2
./tiktokctl.sh profile delete work
./tiktokctl.sh profile backup work [路径]  # 导出单文件（默认 ~/.tiktok-sig-auth/backups/）
./tiktokctl.sh profile import <文件> [名字] # 导入：本工具备份 或 扩展导出的 JSON

# 启动指定账号（不带名字则弹菜单选）
./tiktokctl.sh start work
./tiktokctl.sh restart play   # 切换账号
./tiktokctl.sh status         # 显示当前账号
```

注入源：设了账号（`--profile`/菜单）走持久化存储；否则回退到 `.env` 的 `CHROME_PROFILE` 实时模式。

⚠️ 保存的会话与备份文件含 `sessionid`（账号完全访问权限），权限 0600、存仓库外，**勿外传、勿放入同步盘/仓库**。
```

- [ ] **Step 2: 提交**

```bash
git add tiktok-auth/README.md
git commit -m "docs(profiles): multi-account CLI usage"
```

---

## Task 13: 全量测试 + 端到端验证

**Files:** 无（验证）

- [ ] **Step 1: 全量单测**

Run: `npm test`
Expected: 全部 PASS（原有 + constants/chrome-cookies/profile-store/cookie-import/parse-args/cli/launcher）。

- [ ] **Step 2: 端到端（需用户真实 Chrome 登录 + 钥匙串授权）**

```bash
# 停掉任何在跑的实例
./tiktokctl.sh stop
# 看可用 Chrome profile
./tiktokctl.sh profile chrome
# 提取一个已登录账号（弹钥匙串，点"始终允许"）
./tiktokctl.sh profile add acct1 --from "<某个已登录的 Chrome profile>"
./tiktokctl.sh profile list
# 启动该账号（这次不读 Chrome、不弹钥匙串）
./tiktokctl.sh start acct1
./tiktokctl.sh status   # 应显示 account: acct1
# 验证登录态
curl -s -X POST http://localhost:8080/fetch -H 'Content-Type: application/json' \
  -d '{"url":"https://www.tiktok.com/passport/web/account/info/"}' | head -c 300
```
Expected: `profile add` 报 "saved profile 'acct1' ..."; `start` 不弹钥匙串、日志出现 `[auth] 注入 N 个 cookie；登录态=是`; `/fetch` 返回该账号信息。

- [ ] **Step 3: 切换账号验证（如有第二个账号）**

```bash
./tiktokctl.sh profile add acct2 --from "<另一个已登录 profile>"
./tiktokctl.sh restart acct2
./tiktokctl.sh status   # account: acct2
```
Expected: status 显示 acct2；`/fetch` 返回 acct2 的信息。

- [ ] **Step 4: 备份/导入往返**

```bash
./tiktokctl.sh profile backup acct1
./tiktokctl.sh profile delete acct1
./tiktokctl.sh profile import ~/.tiktok-sig-auth/backups/acct1-*.json acct1restored
./tiktokctl.sh profile list   # acct1restored 出现，origin/source 保留
```

- [ ] **Step 5: 最终提交（如有验证期微调）**

```bash
git add -A && git status --short
git commit -m "test(profiles): e2e verification adjustments" || echo "无改动"
```

---

## Self-Review 结论

- **Spec 覆盖**：§3 存储/权限/name→Task3/4；§4 格式→Task3(meta)/Task5(import);§4.1 共享常量→Task1+Task2+Task7;§5.1 listChromeProfiles→Task2;§5.2 store→Task3/4;§5.3 cookie-import→Task5;§5.4 profile-cli→Task8/9/10;§5.5 index 修复→Task7;§5.6 auth-server→Task6;§5.7 tiktokctl→Task11;§6 注入流程→Task7;§8 错误矩阵→Task9/10(cli)+Task11(ctl);§9 安全→Task3(原子/权限/符号链接)+Task5(白名单/proto/大小);§10 测试→各任务单测+Task13;§11 退出码→Task8/10(cli)+Task11(ctl)。无遗漏。
- **占位符**：无 TBD/TODO；每个代码步骤含完整代码与命令。
- **类型/命名一致**：`SESSION_COOKIE_NAMES`/`hasSessionCookie`/`listChromeProfiles`/`profileHasLogin`/`baseDir`/`writeProfile`/`readProfile`/`loadProfileCookies`/`profileExists`/`deleteProfile`/`renameProfile`/`backupProfile`/`parseImportFile`/`parseProfileArg`/`getConfiguredCookies`/`run(argv,deps)` 跨任务一致；CLI `deps` 形状（store/importer/listChromeProfiles/getChromeTikTokCookies/isTTY/prompt/readFile/statFile）在 Task8-10 统一。
- **关键修复确认**：Task7 钩子改为 `getCookies()` 无参 + `getConfiguredCookies(deps=realDeps)`，消除签名冲突；Task3 原子写 + 0700/0600 + O_EXCL|O_NOFOLLOW；Task11 restart 先解析后停止。
