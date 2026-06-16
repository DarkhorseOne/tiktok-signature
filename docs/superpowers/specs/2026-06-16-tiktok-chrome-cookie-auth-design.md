# TikTok 登录态注入（从本机 Chrome 提取 Cookie）— 设计文档

- 日期：2026-06-16
- 状态：待实现
- 适用平台：macOS（本机自用）
- 核心约束：**不修改原项目（上游）的任何已跟踪文件**，新功能完全独立，便于后续 merge 上游更新

## 1. 背景与目标

当前项目 [server.mjs](../../../server.mjs) 是一个 TikTok 签名服务：用 `puppeteer-extra` + stealth 启动**无头、未登录**的 Chrome，注入本地 `webmssdk` 生成 `X-Bogus` / `X-Gnarly` 签名，对外提供：

- `POST /signature` — 返回带签名的 URL + 当前 `cookies`（[parseResult](../../../server.mjs)）
- `POST /fetch` — 在浏览器内 `fetch(url, { credentials: "include" })` 直接取数
- `GET /health`、`GET /restart`

问题：部分 TikTok 数据必须登录后才能看到，匿名会话取不到。

**目标**：新增一个**可选开关**。开启后，服务在启动无头浏览器时，从用户本机 Chrome 读取并解密 TikTok 登录 Cookie，注入到无头浏览器中，使：

- `/fetch` 直接返回登录后数据
- `/signature` 返回的 `cookies` 自带登录态，供外部回放

**关闭时行为与现状完全一致**（向后兼容）。

## 2. 关键技术事实（已核实）

TikTok 登录态完全由 Cookie 承载，关键 Cookie：`sessionid` / `sessionid_ss` / `sid_guard` / `sid_tt` / `uid_tt`。

macOS Chrome（含本机 **Chrome 149**）Cookie 解密：

- 存储位置：`~/Library/Application Support/Google/Chrome/<profile>/Cookies`（SQLite）
- 加密算法：**AES-128-CBC**，IV = 16 个空格字节（0x20）
- 密钥：`PBKDF2-HMAC-SHA1(钥匙串密码, salt="saltysalt", iterations=1003, keylen=16)`
- 钥匙串密码：`security find-generic-password -ws "Chrome Safe Storage"`（首次读取弹一次 GUI 授权，可点"始终允许"）
- 密文前缀 `v10`（3 字节，解密前需切除）
- **Chrome 130+（含 149）**：加密前在明文头部追加 32 字节域名 SHA256 哈希，**解密后需切掉前 32 字节**。判据：`meta` 表 `key='version'` 的值 `>= 24`
- macOS 上仍为钥匙串方案，未引入会破坏该方案的 App-Bound 加密（ABE 目前仅 Windows）

来源：
- https://gist.github.com/creachadair/937179894a24571ce9860e2475a2d2ec
- https://github.com/lacherogwu/chrome-cookie-decrypt
- https://www.cyberark.com/resources/threat-research-blog/the-current-state-of-browser-cookies

## 3. 架构：零修改 + 独立启动入口

不改 `server.mjs` 内部逻辑。新增一个启动入口，先在 `puppeteer-extra` 单例上挂好 Cookie 注入钩子，再 `import` 原 `server.mjs`。Node 的模块缓存保证两者拿到的是**同一个** puppeteer 单例。

### 3.1 新增文件（全部为新文件，零触碰上游）

```
auth-server.mjs                 # 新启动入口
tiktokctl.sh                    # 进程管理脚本：start/stop/restart/status/log
tiktok-auth/
  index.mjs                     # installAuthHook()：包装 puppeteer.launch / browser.newPage
  chrome-cookies.mjs            # getChromeTikTokCookies()：提取+解密
  README.md                     # 用法说明 + 升级/merge 说明
  auth-server.pid               # 运行时生成（被 .gitignore 的 *.pid 忽略）
  auth-server.log               # 运行时生成（被 .gitignore 的 *.log 忽略）
  __tests__/
    chrome-cookies.test.mjs     # 纯函数单测（不依赖钥匙串）
```

运行时文件（`*.pid` / `*.log`）已被现有 `.gitignore` 忽略，无需改动 `.gitignore`。

配置写入 `.env`（已被 `.gitignore` 忽略，不影响上游）：

```
TIKTOK_AUTH_ENABLED=true
# 留空或写 auto 则自动探测含 sessionid 的 profile
CHROME_PROFILE=Default
```

### 3.2 钩子机制（`tiktok-auth/index.mjs`）

包装同一个 puppeteer 单例的 `launch`，再包装返回 browser 的 `newPage`，在页面创建后、被 `server.mjs` 导航前注入 Cookie：

```js
// 伪代码
export async function installAuthHook(puppeteer) {
  if (process.env.TIKTOK_AUTH_ENABLED !== "true") return;
  const origLaunch = puppeteer.launch.bind(puppeteer);
  puppeteer.launch = async (opts) => {
    const browser = await origLaunch(opts);
    const origNewPage = browser.newPage.bind(browser);
    browser.newPage = async (...a) => {
      const page = await origNewPage(...a);
      try {
        const cookies = await getChromeTikTokCookies({ profile: process.env.CHROME_PROFILE });
        if (cookies.length) {
          await page.setCookie(...cookies);
          console.log(`[auth] 注入 ${cookies.length} 个 TikTok cookie；登录态=${cookies.some(c => c.name === "sessionid") ? "是" : "否"}`);
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
}
```

选择"包装 launch/newPage"而非 puppeteer-extra 插件的 `onPageCreated`：前者能**确定性保证** `setCookie` 在 `server.mjs` 的 `page.goto` 之前完成（await 完才返回 page），不依赖插件生命周期的时序。

`auth-server.mjs`：

```js
import puppeteer from "puppeteer-extra";
import { installAuthHook } from "./tiktok-auth/index.mjs";
await installAuthHook(puppeteer);
await import("./server.mjs"); // 原文件，零改动，此时启动服务
```

启动命令：`node --env-file-if-exists=.env auth-server.mjs`
（不新增 npm script，避免改动已跟踪的 `package.json`；如需可手动加，冲突很小。）

### 3.3 为什么这样能保证可 merge

- 上游所有已跟踪文件（`server.mjs`、`xgnarly.mjs`、`package.json`、`__tests__/` 等）**一行不改**
- 新增文件都在新路径（`auth-server.mjs`、`tiktok-auth/`），与上游不重名 → `git merge` / `git rebase` 上游时**不可能产生冲突**
- 唯一与上游的耦合点是「`puppeteer-extra` 暴露 `launch`/`newPage`」这一稳定 API；即使上游小幅改动 `server.mjs` 内部，钩子依然生效；万一上游大改（如换 Playwright），钩子失效也只是**回退到匿名模式**，不会让服务崩溃

### 3.4 进程管理脚本（`tiktokctl.sh`）

根目录新增一个 bash 脚本（新文件，与上游不冲突），用纯系统能力实现，零依赖：

| 子命令 | 行为 |
|---|---|
| `start` | 若已在运行则提示并退出；否则后台启动 `node --env-file-if-exists=.env auth-server.mjs`，日志重定向到 `LOG_FILE`，PID 写入 `PID_FILE`，打印 pid |
| `stop` | 读 `PID_FILE`，先发 `SIGTERM`（命中 server.mjs 的优雅关闭，关掉浏览器），等待若干秒仍存活则 `SIGKILL`，删除 `PID_FILE` |
| `restart` | `stop` 后 `start` |
| `status` | 报告是否运行、pid；运行时再 `curl -s localhost:$PORT/health` 展示 `ready`/`initMethod` 等（`PORT` 从 `.env` 读，默认 8080；curl 失败不报错） |
| `log` | `tail -n 100 -f LOG_FILE`（实时跟踪日志） |

实现要点：

- `#!/usr/bin/env bash`；脚本自定位仓库根目录（`cd "$(dirname "$0")"`），不依赖调用方所在目录
- `PID_FILE=tiktok-auth/auth-server.pid`，`LOG_FILE=tiktok-auth/auth-server.log`（均被现有 `.gitignore` 覆盖）
- 存活判定：`kill -0 "$pid" 2>/dev/null`；并校验 `PID_FILE` 里的 pid 仍是本服务（避免 pid 复用误杀）
- 启动用 `nohup ... >> "$LOG_FILE" 2>&1 &` 脱离终端
- 始终启动 `auth-server.mjs`（无论登录开关开关；开关由 `.env` 的 `TIKTOK_AUTH_ENABLED` 控制）
- 退出码语义化：`status` 运行中返回 0、未运行返回 3，便于脚本化

## 4. 提取与解密（`tiktok-auth/chrome-cookies.mjs`）

`getChromeTikTokCookies({ profile }) -> Promise<PuppeteerCookie[]>`

实现方式：**系统 `sqlite3` CLI + `security` + Node `crypto`，零新增 npm 依赖**。

步骤：

1. **定位 profile**：`profile` 为空或 `auto` 时，依次扫描 `Default` / `Profile 1..N`，选第一个含 tiktok `sessionid` 的；否则用指定 profile。找不到任何登录 profile → 返回 `[]`（上层回退匿名）。
2. **拷贝 DB**：把 `Cookies` 拷到临时文件（`os.tmpdir()`），绕开 Chrome 运行时的文件锁；同时拷 `Cookies-wal`/`Cookies-shm`（若存在）。用完 `finally` 删除。
3. **读 meta 版本**：`SELECT value FROM meta WHERE key='version';` → `stripDomainHash = Number(version) >= 24`。
4. **读 cookie 行**（`sqlite3 -json`，本机 3.45 支持）：
   ```sql
   SELECT name, host_key AS domain, path,
          is_secure AS secure, is_httponly AS httpOnly,
          expires_utc AS expires, hex(encrypted_value) AS enc
   FROM cookies WHERE host_key LIKE '%tiktok.com';
   ```
5. **取钥匙串密码**（仅一次，内存缓存）：`security find-generic-password -ws "Chrome Safe Storage"`。
6. **派生密钥**：`crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1")`。
7. **逐条解密**：
   - hex → Buffer；若以 `v10` 开头则切前 3 字节（否则按明文/跳过处理）
   - `createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))`，`autoPadding=true`
   - 若 `stripDomainHash` → 结果 `.slice(32)`
   - `.toString("utf8")` 得到 cookie 值；单条失败则**跳过**不中断
8. **转 Puppeteer 格式**：
   - `expires_utc`（1601 微秒纪元）→ Unix 秒：`value/1e6 - 11644473600`；为 0 时视为会话 cookie（不带 `expires`）
   - 输出 `{ name, value, domain, path, secure: !!secure, httpOnly: !!httpOnly, expires? }`

## 5. 数据流

```
auth-server.mjs
  → installAuthHook(puppeteer)              # 包装 launch/newPage
  → import server.mjs                       # 启动服务（原逻辑）
      → initBrowser → puppeteer.launch      # 命中包装
          → browser.newPage                 # 命中包装：读Chrome→解密→setCookie
          → page.goto(tiktok)               # 已带登录 cookie
          → 注入本地 SDK / 初始化签名函数（原逻辑不变）
  /fetch     → 浏览器内带 credentials 请求   → 登录后数据
  /signature → 签名 URL + cookies(含sessionid) → 外部回放即登录态
```

会话刷新（每 30 分钟 / 500 次，`ensurePageReady`→`closeBrowser`→`initBrowser`）会再次命中包装 → 重新从 Chrome 读取最新 cookie，只要 Chrome 登录态未过期就持续有效。

## 6. 容错（全部回退匿名，不崩溃）

| 情况 | 处理 |
|---|---|
| `TIKTOK_AUTH_ENABLED` 非 true | 钩子直接不安装，行为同现状 |
| 钥匙串授权被拒 / 拿不到密码 | 告警 + 返回 `[]` |
| `sqlite3` 不在 PATH | 尝试 `/usr/bin/sqlite3`；再失败则告警 + `[]` |
| 指定/探测 profile 无 tiktok 登录 cookie | 告警"未登录" + `[]` |
| 单条 cookie 解密失败 | 跳过该条，其余照常 |
| Chrome 锁库 / 拷贝失败 | 重试一次；仍失败则告警 + `[]` |
| Chrome 中登录态已过期 | 注入的过期 cookie 无效 → 表现为匿名/接口报未授权 |

## 7. 安全

- `sessionid` 等于账号完全访问权限。Cookie **只存内存、不落盘、日志只打名称与数量、绝不打印值**；临时 DB 拷贝 `finally` 立即删除。
- ⚠️ `/signature`、`/fetch` 响应**本就会把 cookies 返回给调用方**，开启登录后会含 `sessionid`。**本服务仅限本机自用，切勿对外网暴露**（README 中显著提示）。
- 新增文件不含任何凭据；`.env` 已被忽略。

## 8. 测试

纯函数单测（`tiktok-auth/__tests__/chrome-cookies.test.mjs`，不依赖钥匙串）：

- `chromeTimeToUnix`：1601 微秒纪元 → Unix 秒；0 → 会话 cookie
- `stripDomainHash` 判定：`version >= 24` 时切 32 字节，否则不切
- 解密往返：用已知密码派生密钥，自造 `v10 + 32字节哈希 + PKCS7` 密文，解密断言还原
- cookie → Puppeteer 字段映射（secure/httpOnly 0/1 → 布尔，domain/path 透传）
- 回退：`TIKTOK_AUTH_ENABLED` 关 / `sqlite3` 缺失 / 无 cookie 时返回 `[]` 且不抛

手动集成：开开关后 `/fetch` 打一个需登录接口，确认返回登录数据；`/health` 仍正常（未改动）。

## 9. 明确不做（YAGNI）

- 不做账号密码自动登录（验证码/2FA/封号风险）
- 不做 Linux/Windows 的 cookie 提取（本机 macOS 自用）
- 不改 `/health`、不改 `server.mjs`、不改 `package.json`
- 不做 cookie 自动续期/写回 Chrome
