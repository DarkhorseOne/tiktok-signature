# 账号为中心的 Profile 提取 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `profile add`/`refresh` 以"当前 Chrome 里登录的 TikTok 会话"为中心:自动定位已登录的 Chrome profile、抓取 TikTok @用户名、用它默认命名、并让 refresh 防止抓错账号。

**Architecture:** 纯 add-on 改动。新增 `account-info.mjs`(离线 cookie 鉴权抓 @用户名);`profile-store.writeProfile` 透传/保留 `tiktok*` 字段;`profile-cli` 的 `cmdAdd`/`cmdRefresh`/`cmdList` 改造,身份抓取经依赖注入。

**Tech Stack:** Node.js ESM、`undici`(已依赖)、jest 30 (ESM)。

## Global Constraints
- **零上游改动**:不碰 `server.mjs`/`xgnarly.mjs`/`package.json`/`.gitignore`/根 `__tests__/`。
- 新测试放 `tiktok-auth/__tests__/`。单测命令:`node --experimental-vm-modules node_modules/.bin/jest <file>`。
- 所有网络/Chrome 访问经依赖注入,单测不联网、不读真实 Chrome。
- 分支 `feature/account-centric-profiles`(spec 已提交)。

**Spec:** [docs/superpowers/specs/2026-06-17-account-centric-profiles-design.md](../specs/2026-06-17-account-centric-profiles-design.md)

---

## 文件结构

| 文件 | 改动 | 任务 |
|---|---|---|
| `tiktok-auth/account-info.mjs` | 新建 `parseIdentity` + `fetchTikTokIdentity` | T1 |
| `tiktok-auth/profile-store.mjs` | `writeProfile` 透传/保留 `tiktok*` | T2 |
| `tiktok-auth/profile-cli.mjs` | `cmdAdd` 改造 + `pickChromeProfile` + `makeRealDeps.fetchIdentity` | T3 |
| `tiktok-auth/profile-cli.mjs` | `cmdRefresh` 身份校验 | T4 |
| `tiktok-auth/profile-cli.mjs` | `cmdList` 显示 @用户名 | T5 |
| `tiktok-auth/README.md` | 用法更新 | T6 |

---

## Task 1: account-info.mjs

**Files:**
- Create: `tiktok-auth/account-info.mjs`
- Test: `tiktok-auth/__tests__/account-info.test.mjs`

**Interfaces:**
- Produces: `parseIdentity(text) -> {username,screenName,userId}|null`; `fetchTikTokIdentity(cookies, {request?, timeoutMs?}) -> Promise<identity|null>`

- [ ] **Step 1: failing test** — `tiktok-auth/__tests__/account-info.test.mjs`:

```js
import { parseIdentity, fetchTikTokIdentity } from "../account-info.mjs";

describe("parseIdentity", () => {
  test("parses username/screen_name/user_id from account info JSON", () => {
    const text = JSON.stringify({ data: { username: "nick", screen_name: "Nick M", user_id_str: "765" }, message: "success" });
    expect(parseIdentity(text)).toEqual({ username: "nick", screenName: "Nick M", userId: "765" });
  });
  test("missing username -> null", () => {
    expect(parseIdentity(JSON.stringify({ data: { screen_name: "x" } }))).toBeNull();
  });
  test("bad JSON -> null", () => {
    expect(parseIdentity("not json")).toBeNull();
  });
});

describe("fetchTikTokIdentity", () => {
  const cookies = [{ name: "sessionid", value: "s" }];
  test("returns identity on 200 with valid body", async () => {
    const fakeReq = async () => ({ statusCode: 200, body: { text: async () => JSON.stringify({ data: { username: "nick", screen_name: "N", user_id_str: "1" } }) } });
    expect(await fetchTikTokIdentity(cookies, { request: fakeReq })).toEqual({ username: "nick", screenName: "N", userId: "1" });
  });
  test("non-200 -> null", async () => {
    const fakeReq = async () => ({ statusCode: 401, body: { text: async () => "" } });
    expect(await fetchTikTokIdentity(cookies, { request: fakeReq })).toBeNull();
  });
  test("request throws -> null", async () => {
    const fakeReq = async () => { throw new Error("net"); };
    expect(await fetchTikTokIdentity(cookies, { request: fakeReq })).toBeNull();
  });
  test("no cookies -> null", async () => {
    let called = false;
    const fakeReq = async () => { called = true; return { statusCode: 200, body: { text: async () => "" } }; };
    expect(await fetchTikTokIdentity([], { request: fakeReq })).toBeNull();
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: run, confirm FAIL** — `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/account-info.test.mjs` → `Cannot find module`.

- [ ] **Step 3: implement** — `tiktok-auth/account-info.mjs`:

```js
import { request as undiciRequest } from "undici";

const ENDPOINT = "https://www.tiktok.com/passport/web/account/info/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

/** 解析 account/info 响应文本 -> {username,screenName,userId}；无 username/坏 JSON -> null */
export function parseIdentity(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const data = d && d.data ? d.data : null;
  if (!data || !data.username) return null;
  return {
    username: String(data.username),
    screenName: data.screen_name ? String(data.screen_name) : "",
    userId: String(data.user_id_str || data.user_id || ""),
  };
}

/**
 * 用 cookie 鉴权抓 TikTok 身份。尽力而为:非 200/异常/无 cookie/解析失败 -> null。
 * request 可注入便于测试。
 */
export async function fetchTikTokIdentity(cookies, { request = undiciRequest, timeoutMs = 5000 } = {}) {
  try {
    const cookieHeader = (cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
    if (!cookieHeader) return null;
    const res = await request(ENDPOINT, {
      method: "GET",
      headers: { cookie: cookieHeader, "user-agent": UA, accept: "application/json" },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      maxRedirections: 0,
    });
    if (res.statusCode !== 200) return null;
    const text = await res.body.text();
    return parseIdentity(text);
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 4: run, confirm PASS** (7 tests).
- [ ] **Step 5: commit**

```bash
cd /Users/nickma/Develop/TikTok/tiktok-signature
git add tiktok-auth/account-info.mjs tiktok-auth/__tests__/account-info.test.mjs
git commit -m "feat(profiles): account-info — offline TikTok identity capture"
```

---

## Task 2: writeProfile stores/preserves tiktok identity

**Files:**
- Modify: `tiktok-auth/profile-store.mjs` (the `writeProfile` function, currently lines ~105-129)
- Test: `tiktok-auth/__tests__/profile-store.test.mjs` (append)

**Interfaces:**
- Consumes: existing `writeProfile(name, cookies, metaIn)`, `readProfile(name)`.
- Produces: `writeProfile` now reads `metaIn.tiktokUsername`/`tiktokScreenName`/`tiktokUserId`; for each, explicit value (incl `null`) wins, `undefined` preserves the existing meta value, new+unset → `null`.

- [ ] **Step 1: append failing tests** to `tiktok-auth/__tests__/profile-store.test.mjs` (the file already imports `writeProfile`, `readProfile`, defines `home`/`COOKIES`):

```js
describe("tiktok identity fields", () => {
  test("writeProfile stores tiktok identity", () => {
    const meta = writeProfile("acct", COOKIES, { origin: "chrome", sourceChromeProfile: "Default", tiktokUsername: "u", tiktokScreenName: "s", tiktokUserId: "123" });
    expect(meta).toMatchObject({ tiktokUsername: "u", tiktokScreenName: "s", tiktokUserId: "123" });
    expect(readProfile("acct").meta.tiktokUserId).toBe("123");
  });
  test("undefined preserves existing identity; null clears it", () => {
    writeProfile("acct", COOKIES, { tiktokUsername: "u", tiktokUserId: "123" });
    const m1 = writeProfile("acct", COOKIES, { origin: "chrome", sourceChromeProfile: "Default" }); // omit -> preserve
    expect(m1.tiktokUsername).toBe("u");
    expect(m1.tiktokUserId).toBe("123");
    const m2 = writeProfile("acct", COOKIES, { tiktokUsername: null }); // explicit null -> clear
    expect(m2.tiktokUsername).toBeNull();
  });
  test("new profile without identity defaults to null", () => {
    const meta = writeProfile("fresh", COOKIES, { origin: "chrome", sourceChromeProfile: "Default" });
    expect(meta.tiktokUsername).toBeNull();
    expect(meta.tiktokUserId).toBeNull();
  });
});
```

- [ ] **Step 2: run, confirm new FAIL** — `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/profile-store.test.mjs`.

- [ ] **Step 3: implement** — replace the `writeProfile` function body in `tiktok-auth/profile-store.mjs` with:

```js
export function writeProfile(name, cookies, metaIn = {}) {
  assertValidName(name);
  const dir = profileDir(name);
  assertContained(profilesDir(), dir);
  ensureDirs(profilesDir(), dir);

  const metaPath = path.join(dir, "meta.json");
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (e) {}
  const keep = (k) => (metaIn[k] !== undefined ? metaIn[k] : prev[k] ?? null);
  const now = new Date().toISOString();
  const meta = {
    name,
    origin: metaIn.origin === "imported" ? "imported" : "chrome",
    sourceChromeProfile: metaIn.sourceChromeProfile ?? null,
    tiktokUsername: keep("tiktokUsername"),
    tiktokScreenName: keep("tiktokScreenName"),
    tiktokUserId: keep("tiktokUserId"),
    createdAt: prev.createdAt || now,
    refreshedAt: now,
    cookieCount: Array.isArray(cookies) ? cookies.length : 0,
    hasSession: hasSessionCookie(cookies),
  };
  secureWriteFile(path.join(dir, "cookies.json"), JSON.stringify(cookies, null, 2));
  secureWriteFile(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}
```

- [ ] **Step 4: run, confirm PASS** — run profile-store.test.mjs (all prior + 3 new) AND full `npm test 2>&1 | tail -5` (the round-trip `toEqual` test still passes since both sides gain `tiktok*: null`).
- [ ] **Step 5: commit**

```bash
git add tiktok-auth/profile-store.mjs tiktok-auth/__tests__/profile-store.test.mjs
git commit -m "feat(profiles): writeProfile stores/preserves tiktok identity"
```

---

## Task 3: cmdAdd auto-detect + identity capture + name default

**Files:**
- Modify: `tiktok-auth/profile-cli.mjs` (`cmdAdd`, replace `interactiveAdd` with `pickChromeProfile`, `makeRealDeps`)
- Test: `tiktok-auth/__tests__/cli.test.mjs` (update `makeDeps` helper; append add tests)

**Interfaces:**
- Consumes: `deps.listChromeProfiles()` rows `{profile,hasLogin,name,email}`; `deps.getChromeTikTokCookies({profile})`; `deps.fetchIdentity(cookies) -> {username,screenName,userId}|null`; `deps.store.writeProfile`/`profileExists`; `deps.isTTY`; `deps.prompt`.
- Produces: `cmdAdd` behavior per spec §2.1/§2.3; `fetchIdentity` added to real deps.

- [ ] **Step 1: update `makeDeps` + append failing tests** in `tiktok-auth/__tests__/cli.test.mjs`.

(a) In the `makeDeps(over)` helper, add two defaults so add/refresh never crash on missing deps. The helper's returned object must include (alongside existing keys):
```js
    getChromeTikTokCookies: async () => [],
    fetchIdentity: async () => null,
```
(place them before the final `...over` spread so overrides still win).

(b) Append to the `describe("add / refresh", ...)` block (or a new `describe("add auto-detect", ...)`):
```js
describe("add auto-detect + identity", () => {
  function addDeps(over) {
    const saved = {};
    const deps = makeDeps({
      store: {
        profileExists: (n) => Object.prototype.hasOwnProperty.call(saved, n),
        writeProfile: (n, cookies, meta) => { saved[n] = { cookies, meta }; return { name: n, ...meta, hasSession: true }; },
      },
      getChromeTikTokCookies: async () => [{ name: "sessionid", domain: ".tiktok.com" }],
      ...over,
    });
    deps.__saved = saved;
    return deps;
  }

  test("auto-uses the single logged-in Chrome profile and names by @username", async () => {
    const deps = addDeps({
      listChromeProfiles: () => [{ profile: "Default", hasLogin: true }, { profile: "Profile 1", hasLogin: false }],
      fetchIdentity: async () => ({ username: "nickma2026", screenName: "马剑873", userId: "765" }),
    });
    const r = await run(["add"], deps);
    expect(r.code).toBe(0);
    expect(deps.__saved.nickma2026).toBeDefined();
    expect(deps.__saved.nickma2026.meta).toMatchObject({ sourceChromeProfile: "Default", tiktokUsername: "nickma2026", tiktokUserId: "765" });
  });

  test("errors when no Chrome profile is logged into TikTok", async () => {
    const deps = addDeps({ listChromeProfiles: () => [{ profile: "Default", hasLogin: false }] });
    const r = await run(["add"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/没有已登录|logged/i);
  });

  test("multiple logged-in + non-TTY requires --from", async () => {
    const deps = addDeps({ isTTY: false, listChromeProfiles: () => [{ profile: "Default", hasLogin: true }, { profile: "Profile 1", hasLogin: true }] });
    const r = await run(["add"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--from/);
  });

  test("no name + identity capture fails + non-TTY -> error", async () => {
    const deps = addDeps({ isTTY: false, listChromeProfiles: () => [{ profile: "Default", hasLogin: true }], fetchIdentity: async () => null });
    const r = await run(["add"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/name required/i);
  });

  test("explicit name overrides @username but identity is still stored", async () => {
    const deps = addDeps({
      listChromeProfiles: () => [{ profile: "Default", hasLogin: true }],
      fetchIdentity: async () => ({ username: "nickma2026", screenName: "x", userId: "765" }),
    });
    const r = await run(["add", "work"], deps);
    expect(r.code).toBe(0);
    expect(deps.__saved.work.meta).toMatchObject({ tiktokUsername: "nickma2026", tiktokUserId: "765" });
  });
});
```

- [ ] **Step 2: run, confirm new FAIL** — `node --experimental-vm-modules node_modules/.bin/jest tiktok-auth/__tests__/cli.test.mjs`.

- [ ] **Step 3: implement** — in `tiktok-auth/profile-cli.mjs`:

(a) Add `fetchTikTokIdentity` import (merge with existing imports near the top):
```js
import { fetchTikTokIdentity } from "./account-info.mjs";
```

(b) Replace the whole `cmdAdd` function AND the `interactiveAdd` function with:
```js
async function cmdAdd(rest, deps) {
  let name = positionals(rest)[0];
  let from = flagVal(rest, "--from");
  const force = hasFlag(rest, "--force");

  // Resolve source Chrome profile: explicit --from, else auto-detect logged-in ones.
  if (from) {
    if (!deps.listChromeProfiles().some((p) => p.profile === from)) {
      return userErr(`Chrome profile not found / no Cookies: ${from}`);
    }
  } else {
    const loggedIn = deps.listChromeProfiles().filter((p) => p.hasLogin);
    if (loggedIn.length === 0) {
      return userErr("Chrome 里没有已登录 TikTok 的会话；请先在 Chrome 登录 TikTok");
    } else if (loggedIn.length === 1) {
      from = loggedIn[0].profile;
    } else if (deps.isTTY) {
      from = await pickChromeProfile(loggedIn, deps);
      if (!from) return userErr("add: cancelled");
    } else {
      return userErr("multiple logged-in Chrome profiles; pass --from <profile>");
    }
  }

  const cookies = await deps.getChromeTikTokCookies({ profile: from });
  if (!cookies || !cookies.length) {
    return userErr(`no cookies extracted from Chrome profile: ${from}`);
  }

  const id = await deps.fetchIdentity(cookies);

  if (!name) {
    if (id && id.username) name = id.username;
    else if (deps.isTTY) name = (await deps.prompt("给这个账号起个名字: ")).trim();
    if (!name) return userErr("add: name required (could not capture TikTok username)");
  }

  if (deps.store.profileExists(name) && !force) {
    return userErr(`profile already exists: ${name} (use --force or refresh)`);
  }

  let meta;
  try {
    meta = deps.store.writeProfile(name, cookies, {
      origin: "chrome",
      sourceChromeProfile: from,
      tiktokUsername: id ? id.username : null,
      tiktokScreenName: id ? id.screenName : null,
      tiktokUserId: id ? id.userId : null,
    });
  } catch (e) {
    return userErr(e.message);
  }
  const who = id ? ` (@${id.username}${id.screenName ? " / " + id.screenName : ""})` : " (TikTok 用户名未获取)";
  const warn = meta.hasSession ? "" : "\n[warn] 提取结果不含 sessionid";
  return ok(`saved profile '${name}' from Chrome '${from}'${who} (${cookies.length} cookies)${warn}`);
}

async function pickChromeProfile(rows, deps) {
  const lines = rows.map((p, i) => `${i + 1}) ${p.profile}  ${p.name || ""}${p.email ? " (" + p.email + ")" : ""}`);
  const sel = await deps.prompt(`多个已登录 TikTok 的 Chrome profile，选一个:\n${lines.join("\n")}\n序号: `);
  const idx = Number(sel) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) return null;
  return rows[idx].profile;
}
```

(c) In `makeRealDeps()`, add the identity provider (one line in the returned object):
```js
    fetchIdentity: (cookies) => fetchTikTokIdentity(cookies),
```

- [ ] **Step 4: run, confirm PASS** — cli.test.mjs all pass; then `npm test 2>&1 | tail -5` all green (existing add tests that pass `--from` still pass; they now also call `deps.fetchIdentity` which defaults to `async () => null`).
- [ ] **Step 5: commit**

```bash
git add tiktok-auth/profile-cli.mjs tiktok-auth/__tests__/cli.test.mjs
git commit -m "feat(profiles): add auto-detects logged-in Chrome, captures @username, defaults name"
```

---

## Task 4: cmdRefresh identity capture + account-changed guard

**Files:**
- Modify: `tiktok-auth/profile-cli.mjs` (`cmdRefresh`)
- Test: `tiktok-auth/__tests__/cli.test.mjs` (append)

**Interfaces:**
- Consumes: `deps.store.readProfile(name).meta` (now may carry `tiktokUserId`/`tiktokUsername`); `deps.fetchIdentity`; `deps.getChromeTikTokCookies`; `hasSessionCookie`.
- Produces: `cmdRefresh` refuses when `meta.tiktokUserId` ≠ freshly-captured `userId` unless `--force`; passes `undefined` identity to `writeProfile` when capture fails (store preserves).

- [ ] **Step 1: append failing tests** to `tiktok-auth/__tests__/cli.test.mjs`:

```js
describe("refresh account-changed guard", () => {
  function refDeps(over) {
    const saved = { acct: { cookies: [{ name: "sessionid" }], meta: { origin: "chrome", sourceChromeProfile: "Default", tiktokUserId: "111", tiktokUsername: "a" } } };
    let writtenMeta = null;
    const deps = makeDeps({
      store: {
        readProfile: (n) => { if (!saved[n]) throw new Error("nf"); return { meta: { name: n, ...saved[n].meta }, cookies: saved[n].cookies }; },
        writeProfile: (n, c, m) => { writtenMeta = m; saved[n] = { cookies: c, meta: { ...saved[n].meta, ...m } }; return { name: n }; },
      },
      getChromeTikTokCookies: async () => [{ name: "sessionid", domain: ".tiktok.com" }],
      ...over,
    });
    deps.__saved = saved;
    deps.__written = () => writtenMeta;
    return deps;
  }

  test("refuses when active TikTok account changed (userId mismatch)", async () => {
    const deps = refDeps({ fetchIdentity: async () => ({ username: "b", screenName: "", userId: "222" }) });
    const r = await run(["refresh", "acct"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/changed|replace/i);
    expect(deps.__written()).toBeNull(); // writeProfile NOT called
  });

  test("--force overrides the account-changed guard", async () => {
    const deps = refDeps({ fetchIdentity: async () => ({ username: "b", screenName: "", userId: "222" }) });
    const r = await run(["refresh", "acct", "--force"], deps);
    expect(r.code).toBe(0);
    expect(deps.__written().tiktokUserId).toBe("222");
  });

  test("same account refreshes normally", async () => {
    const deps = refDeps({ fetchIdentity: async () => ({ username: "a", screenName: "", userId: "111" }) });
    const r = await run(["refresh", "acct"], deps);
    expect(r.code).toBe(0);
    expect(deps.__written().tiktokUserId).toBe("111");
  });

  test("identity capture failure passes undefined (store preserves)", async () => {
    const deps = refDeps({ fetchIdentity: async () => null });
    const r = await run(["refresh", "acct"], deps);
    expect(r.code).toBe(0);
    expect(deps.__written().tiktokUserId).toBeUndefined();
  });
});
```

- [ ] **Step 2: run, confirm new FAIL**.

- [ ] **Step 3: implement** — replace the whole `cmdRefresh` function in `tiktok-auth/profile-cli.mjs` with:

```js
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
  if (!cookies || !cookies.length) {
    return userErr(`refresh: no cookies extracted from Chrome profile: ${meta.sourceChromeProfile} (kept existing session)`);
  }
  if (!hasSessionCookie(cookies) && !force) {
    return userErr(`refresh got no session cookie for '${name}'; kept existing session (use --force to overwrite)`);
  }
  const id = await deps.fetchIdentity(cookies);
  if (meta.tiktokUserId && id && id.userId && id.userId !== meta.tiktokUserId && !force) {
    return userErr(
      `refresh would replace @${meta.tiktokUsername || meta.tiktokUserId} with @${id.username}; the active TikTok account in Chrome changed. Switch back or use --force.`,
    );
  }
  deps.store.writeProfile(name, cookies, {
    origin: "chrome",
    sourceChromeProfile: meta.sourceChromeProfile,
    tiktokUsername: id ? id.username : undefined,
    tiktokScreenName: id ? id.screenName : undefined,
    tiktokUserId: id ? id.userId : undefined,
  });
  return ok(`refreshed '${name}' from Chrome '${meta.sourceChromeProfile}'${id ? " (@" + id.username + ")" : ""} (${cookies.length} cookies)`);
}
```

- [ ] **Step 4: run, confirm PASS** — cli.test.mjs + `npm test 2>&1 | tail -5` all green. NOTE the prior "refresh re-extracts from source" / data-safety tests have no `tiktokUserId` in their fixtures → the mismatch guard is skipped → they still pass.
- [ ] **Step 5: commit**

```bash
git add tiktok-auth/profile-cli.mjs tiktok-auth/__tests__/cli.test.mjs
git commit -m "feat(profiles): refresh captures identity and refuses account swap without --force"
```

---

## Task 5: cmdList shows @username

**Files:**
- Modify: `tiktok-auth/profile-cli.mjs` (`cmdList`)
- Test: `tiktok-auth/__tests__/cli.test.mjs` (append)

**Interfaces:**
- Consumes: `deps.store.listProfiles()` rows `{name, meta}` where meta may carry `tiktokUsername`/`tiktokScreenName`.
- Produces: `list --porcelain` columns `name\torigin\tsourceChromeProfile\ttiktokUsername\trefreshedAt\thasSession`; human output shows `@username (screenName)`.

- [ ] **Step 1: append failing test** to `tiktok-auth/__tests__/cli.test.mjs` (in the `describe("run routing", ...)` block):

```js
  test("list --porcelain includes tiktokUsername column", async () => {
    const deps = makeDeps({
      store: {
        listProfiles: () => [
          { name: "nickma2026", meta: { origin: "chrome", sourceChromeProfile: "Default", tiktokUsername: "nickma2026", tiktokScreenName: "马剑873", refreshedAt: "2026-06-17T00:00:00.000Z", hasSession: true } },
        ],
      },
    });
    const r = await run(["list", "--porcelain"], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("nickma2026\tchrome\tDefault\tnickma2026\t2026-06-17T00:00:00.000Z\ttrue\n");
  });

  test("list (human) shows @username", async () => {
    const deps = makeDeps({
      store: {
        listProfiles: () => [
          { name: "nickma2026", meta: { origin: "chrome", sourceChromeProfile: "Default", tiktokUsername: "nickma2026", tiktokScreenName: "马剑873", refreshedAt: "t", hasSession: true } },
        ],
      },
    });
    const r = await run(["list"], deps);
    expect(r.stdout).toMatch(/@nickma2026/);
    expect(r.stdout).toMatch(/马剑873/);
  });
```

- [ ] **Step 2: run, confirm new FAIL** (the porcelain string won't match — no tiktokUsername column yet).

- [ ] **Step 3: implement** — replace the whole `cmdList` function in `tiktok-auth/profile-cli.mjs` with:

```js
function profileLabel(meta) {
  return meta.tiktokUsername
    ? `@${meta.tiktokUsername}${meta.tiktokScreenName ? " (" + meta.tiktokScreenName + ")" : ""}`
    : "(no @username)";
}

function cmdList(rest, deps) {
  const rows = deps.store.listProfiles();
  if (hasFlag(rest, "--porcelain")) {
    return ok(
      rows
        .map((p) =>
          [
            p.name,
            p.meta.origin,
            p.meta.sourceChromeProfile || "",
            p.meta.tiktokUsername || "",
            p.meta.refreshedAt,
            String(!!p.meta.hasSession),
          ].join("\t"),
        )
        .map((l) => l + "\n")
        .join(""),
    );
  }
  if (!rows.length) return ok("(no saved profiles; run `profile add`)");
  return ok(
    rows
      .map(
        (p) =>
          `${p.name}\t${profileLabel(p.meta)}\t[${p.meta.origin}${p.meta.sourceChromeProfile ? " " + p.meta.sourceChromeProfile : ""}]\t${p.meta.refreshedAt}\t${p.meta.hasSession ? "✅" : "❌"}`,
      )
      .join("\n"),
  );
}
```

- [ ] **Step 4: run, confirm PASS** — cli.test.mjs + `npm test 2>&1 | tail -5` all green. (The existing Task 8 `list --porcelain` test used fixtures without `tiktokUsername` → that column is empty string; if that older test asserts the exact old column layout it must be updated to include the empty `tiktokUsername` column — update it to: `"work\tchrome\tProfile 1\t\t2026-06-16T00:00:00.000Z\ttrue\n" + "play\timported\t\t\t2026-06-16T00:00:00.000Z\tfalse\n"`.)
- [ ] **Step 5: commit**

```bash
git add tiktok-auth/profile-cli.mjs tiktok-auth/__tests__/cli.test.mjs
git commit -m "feat(profiles): list shows TikTok @username"
```

---

## Task 6: README update

**Files:**
- Modify: `tiktok-auth/README.md`

- [ ] **Step 1:** In the "## 多账号管理（profile）" section, replace the `profile add` example lines so they reflect auto-detect + @username. Specifically change the block:
```bash
# 提取保存一个账号（交互选 Chrome profile + 起名；或直接指定）
./tiktokctl.sh profile add work --from "Profile 1"
```
to:
```bash
# 提取保存“当前 Chrome 里登录的 TikTok 账号”（自动定位已登录的 profile；自动以 @用户名命名）
./tiktokctl.sh profile add
# 在 Chrome 切换/重登另一个 TikTok 账号后，再次：
./tiktokctl.sh profile add
# （也可显式命名/指定来源）：./tiktokctl.sh profile add 别名 --from "Default"
```
And add one line after the `profile list` mention:
```markdown
`profile list` 按 TikTok @用户名显示已保存账号。`refresh` 会校验 Chrome 当前登录的 TikTok 账号是否与该 profile 一致，不一致会拒绝（除非 `--force`）。
```

- [ ] **Step 2: commit**

```bash
git add tiktok-auth/README.md
git commit -m "docs(profiles): account-centric add + @username listing"
```

---

## Task 7: full tests + e2e verification

**Files:** none (verification)

- [ ] **Step 1: full suite** — `npm test` → all green (prior 74 + new account-info/add/refresh/list/store tests).

- [ ] **Step 2: e2e (needs the user's real Chrome + a logged-in TikTok account)** — stop any running server, then:
```bash
./tiktokctl.sh stop
./tiktokctl.sh profile add            # auto-detects Default, captures @username, saves as @username (keychain may prompt)
./tiktokctl.sh profile list           # shows @username (screen_name)
./tiktokctl.sh start <@username>
./tiktokctl.sh status                 # account: <@username>
curl -s -X POST http://localhost:8080/fetch -H 'Content-Type: application/json' \
  -d '{"url":"https://www.tiktok.com/passport/web/account/info/"}' | head -c 200
```
Expected: `profile add` (no args) saves under the TikTok @username with identity captured; `/fetch` returns that account.

- [ ] **Step 3: account-switch guard (manual, if a second TikTok account is available)** — in Chrome switch TikTok account, then `./tiktokctl.sh profile refresh <old-@username>` → expect refusal ("account changed ... use --force"). Switching back and refreshing → succeeds.

- [ ] **Step 4: final commit (if any verification tweaks)**
```bash
git add -A && git status --short
git commit -m "test(profiles): account-centric e2e adjustments" || echo "no changes"
```

---

## Self-Review
- **Spec coverage:** §2.1 auto-detect→T3; §2.2 identity module→T1, wired in T3/T4; §2.3 name default→T3; §2.4 refresh guard→T4; §2.5 meta fields/preserve→T2; §2.6 list→T5; §6 README→T6; §7 tests→each task + T7. No gaps.
- **Placeholders:** none; every code step has complete code + commands.
- **Type consistency:** `parseIdentity`/`fetchTikTokIdentity` (T1) → `deps.fetchIdentity(cookies)->{username,screenName,userId}|null` used identically in T3/T4; `writeProfile` `tiktok*` undefined-preserve/null-clear contract (T2) relied on by T4's `undefined` pass-through; `list --porcelain` 6-column layout (T5) — T5 Step 4 notes updating the older Task-8 porcelain test fixture to add the empty username column.
