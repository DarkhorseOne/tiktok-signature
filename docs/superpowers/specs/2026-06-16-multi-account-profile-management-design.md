# 多账号 Profile 管理 — 设计文档 (v2)

- 日期：2026-06-16
- 状态：待实现
- 平台：macOS（本机自用）
- 分支：`feature/multi-account-profiles`
- 前置：基于已合并的 [Chrome cookie 登录态注入](2026-06-16-tiktok-chrome-cookie-auth-design.md)
- 核心约束：**不修改原项目任何已跟踪文件**（含 `server.mjs` / `xgnarly.mjs` / `package.json` / `.gitignore` / 根 `__tests__/`），新增/改动全部限于 add-on 文件（`auth-server.mjs`、`tiktokctl.sh`、`tiktok-auth/`，含其 `__tests__/`）
- v2 说明：经 5 视角对抗式评审 + 综合后修订，修掉注入签名冲突、落盘权限/umask 窗口、路径穿越、restart 时序等问题。

## 1. 背景与目标

已合并的登录态功能在服务启动时**实时**读 Chrome 注入 cookie，单账号由 `.env` 的 `CHROME_PROFILE` 决定。用户有多个 TikTok 账号，**每个账号 = 一个 Chrome profile**。目标：

1. **启动时选择**加载哪个账号（一次跑一个；换号 = 重启切换）。
2. 统一 CLI 管理多账号会话：提取（add）、列出、刷新、改名、删除、备份、导入。
3. 会话**持久化**保存，启动时直接加载（不读 Chrome、不弹钥匙串、Chrome 可关闭）。

## 2. 模型与关键决策

- **一次一个实例**：与 `.chrome-profile` userDataDir + 端口单例绑定。换号 = `restart <name>`。
- **账号 = Chrome profile**：提取来源是某 Chrome profile。
- **工具自管持久化 profile**：保存于仓库外 `~/.tiktok-sig-auth/`（避开 `.gitignore`、更安全）。
- **注入源**：`add`/`refresh` 才读 Chrome 解密（钥匙串只在此弹）；`start <name>` 加载已保存 cookie。
- **向后兼容回退**：未设 `TIKTOK_PROFILE` 时沿用旧 `CHROME_PROFILE` 实时路径，行为不变。
- **只读真实 Chrome profile**，绝不写/删/改它。
- **导入**：支持 本工具备份文件 + 浏览器扩展（Cookie-Editor/EditThisCookie）导出 JSON 数组，自动识别。

## 3. 存储布局（`~/.tiktok-sig-auth/`）

base 目录 = `process.env.TIKTOK_SIG_AUTH_HOME || path.join(os.homedir(), ".tiktok-sig-auth")`（可注入，便于测试）。

```
~/.tiktok-sig-auth/                       (dir 0700)
  profiles/                               (dir 0700)
    <name>/                               (dir 0700)
      cookies.json    (file 0600)         # Puppeteer 格式 cookie 数组
      meta.json       (file 0600)         # 见 §4
  backups/                                (dir 0700)
    <name>-<YYYYMMDD-HHMMSS>.json (0600)  # 见 §4
```

**权限必须在创建时即生效（防 umask 窗口）**，见 §5.2。**所有**目录（base、profiles/、backups/、profiles/<name>/）均 0700。

**name 校验**（`assertValidName`）：完全锚定正则 `/^[A-Za-z0-9._-]+$/`，且额外拒绝字面量 `.` 与 `..`。任何把 name 拼进路径后，再做 `path.resolve(joined).startsWith(path.resolve(profilesDir)+path.sep)` 兜底校验（防穿越）。

**base 目录信任**：`baseDir` 视为可信本地配置，必须解析为**绝对、属主为当前用户的目录**；每次操作前 `lstat(baseDir)`，若是符号链接或非当前 uid 拥有则拒绝（见 §9 符号链接防护）。

## 4. 数据格式

### cookies.json
Puppeteer `setCookie` 数组：`[{ name, value, domain, path, secure, httpOnly, expires?, sameSite? }, …]`。

### meta.json（字段由 `writeProfile` 统一管理时间戳与统计）
```json
{
  "name": "work",
  "origin": "chrome",                 // 仅 chrome | imported（不存在 backup）
  "sourceChromeProfile": "Profile 1", // origin=chrome 时有；imported 时为 null
  "createdAt": "2026-06-16T20:00:00.000Z",
  "refreshedAt": "2026-06-16T20:00:00.000Z",
  "cookieCount": 48,
  "hasSession": true                  // 见 §4.1
}
```
**时间戳归属**：`writeProfile` 拥有 `createdAt`/`refreshedAt`：首次创建 `createdAt=refreshedAt=now`；后续写入保留 `createdAt`、`refreshedAt=now`。调用方（add/import/refresh）不传时间戳。`cookieCount`/`hasSession` 也由 `writeProfile` 据 cookies 重新计算（导入的 meta 视为建议值）。

### 备份文件
```json
{
  "type": "tiktok-sig-auth-backup",
  "version": 1,
  "exportedAt": "2026-06-16T20:00:00.000Z",
  "meta": { "...": "嵌入的 §4 meta（含 origin/sourceChromeProfile，使 restore 后仍可 refresh）" },
  "cookies": [ "...puppeteer 数组" ]
}
```

### 扩展导出 JSON（导入用）
顶层数组，元素映射到 Puppeteer：`name/value/domain/path` 直接；`secure/httpOnly`→布尔；`sameSite`：`no_restriction`→`None`、`lax`→`Lax`、`strict`→`Strict`、`unspecified`/缺失→省略；`expires`：`session===true` 或无 `expirationDate`→省略，否则 `Math.floor(expirationDate)`；**仅保留 `domain` 以 `tiktok.com` 结尾的 cookie**。

### 4.1 统一登录态判定
定义共享常量 `SESSION_COOKIE_NAMES = ['sessionid','sessionid_ss','sid_guard']`（置于新 `tiktok-auth/constants.mjs`）。以下全部引用它，确保口径一致：
- `chrome-cookies.mjs` 的 `profileHasLogin`（Chrome 侧 `hasLogin`）
- `meta.hasSession`（`cookies.some(c => SESSION_COOKIE_NAMES.includes(c.name))`）
- `add`/`import`/`refresh` 的"无登录态"告警
- `index.mjs` 注入日志的"登录态=是/否"

## 5. 组件拆分（全为 add-on）

| 文件 | 职责 | 类型 |
|---|---|---|
| `tiktok-auth/constants.mjs` | `SESSION_COOKIE_NAMES` 等共享常量 | 新建 |
| `tiktok-auth/chrome-cookies.mjs` | 现有提取 + `enumerateChromeProfiles` + `listChromeProfiles`（探针可注入）+ 纯 `parseLocalStateNames` | 修改（追加） |
| `tiktok-auth/profile-store.mjs` | `~/.tiktok-sig-auth` CRUD + 备份 + 原子安全写 + 权限/符号链接防护 | 新建 |
| `tiktok-auth/cookie-import.mjs` | `parseImportFile`（自动识别 备份/扩展，含安全加固） | 新建 |
| `tiktok-auth/profile-cli.mjs` | 纯 `run(argv, deps)->{code,stdout,stderr}` 核心 + 薄 shim；子命令 list/chrome/add/refresh/rename/delete/backup/import/pick-start/exists/ps-profile | 新建 |
| `tiktok-auth/index.mjs` | `getConfiguredCookies(deps=realDeps)` + 钩子改为 `getCookies()` 无参调用 | 修改 |
| `auth-server.mjs` | 导出纯 `parseProfileArg(argv)`；`--profile` → `process.env.TIKTOK_PROFILE` | 修改 |
| `tiktokctl.sh` | `profile` 透传 node CLI；`start [name]` 加载存储 profile；`status`/`restart` 经 node 解析当前 profile；`TIKTOKCTL_DRY_RUN` 钩子 | 修改 |

### 5.1 `chrome-cookies.mjs` 新增
- `parseLocalStateNames(content)`（纯）：解析 `Local State` JSON 的 `profile.info_cache`，返回 `{ "<dir>": { name, email } }`（`email`=`user_name`，缺省 `""`）。坏 JSON → `{}`。
- `enumerateChromeProfiles(chromeDir)`：以 `Local State` 的 `profile.info_cache` 键为权威列表，与"存在 `Cookies` 文件"的目录取交集；`Local State` 不可读时回退扫描 `Default` + 实际存在的 `Profile *` 目录（不再硬编码 1..20）。
- `listChromeProfiles({ chromeDir, hasLogin = profileHasLogin, readLocalState = <默认读文件> } = {})`：对每个枚举到的 profile 返回 `{ profile, hasLogin, name, email }`。探针 `hasLogin`/`readLocalState` 可注入（便于无 sqlite3 单测）。单项失败跳过；整体不抛。
- 导出 `profileHasLogin`（供注入默认值）并使其使用 `SESSION_COOKIE_NAMES`。

### 5.2 `profile-store.mjs`（安全写是重点）
- `baseDir()`、`profilesDir()`、`backupsDir()`、`profilePath(name)`；启动各操作前对 `baseDir` 做符号链接/属主校验。
- **`secureWriteFile(filePath, data)`**：在**同目录**写临时文件 `(<name>.<rand>.tmp)`，用 `fs.openSync(tmp, 'wx', 0o600)`（或 `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`）→ 写 → `fsyncSync` → `fs.renameSync(tmp, filePath)`（原子、无可读窗口、防符号链接重定向）；再 `chmodSync(filePath, 0o600)` 兜底。
- **`secureMkdir(dir)`**：`mkdirSync(dir, { recursive:true, mode:0o700 })` 后立即 `chmodSync(dir, 0o700)`（mode 受 umask 影响，需补 chmod）。
- `listProfiles()` → `[{name, meta}]`（按 name 排序；跳过无合法 meta 的脏目录）。
- `readProfile(name)` / `loadProfileCookies(name)` → 不存在抛 `Error("profile not found: <name>")`。
- `writeProfile(name, cookies, metaIn)` → `assertValidName`；`secureMkdir`；计算 `cookieCount`/`hasSession`；管理时间戳（§4）；`secureWriteFile` 写两文件。
- `deleteProfile(name)` → `lstat` 目标，若为符号链接或解析后不在 `profilesDir` 之下则拒绝；否则 `fs.rmSync(dir,{recursive:true})`。不存在抛。
- `renameProfile(old, neu)` → 校验 `neu` 合法且不存在；`renameSync`；更新 `meta.name`（经 `writeProfile`/直接改写 meta，保留时间戳）。
- `backupProfile(name, destPath?)` → 默认 `backups/<name>-<时间戳>.json`；destPath 给定时解析为绝对路径、按需创建父目录（0700）、**强制 0600**、`flag:'wx'`（已存在则报错、不跟随符号链接）；若解析后落在 git 工作树内 → stderr 告警（仍写，标注"仅本地可信")。

### 5.3 `cookie-import.mjs`
- `parseImportFile(content)` → `{ cookies, meta? }`：
  - 顶层数组 → 扩展格式 → 映射（§4），仅保留 tiktok 域；返回 `{cookies}`（无 meta）。
  - 顶层对象且 `Array.isArray(obj.cookies)` → 备份格式 → 返回 `{cookies: obj.cookies, meta: obj.meta}`。
  - 其它 → 抛 `Error("unrecognized import format")`。
- **安全加固**：调用方先 `statSync` 文件，超过 5 MB 拒绝再读；构造 cookie/meta 一律走**显式字段白名单**（不 `Object.assign` 攻击者对象）；跳过键名 `__proto__`/`constructor`/`prototype`；导入后 `cookieCount`/`hasSession` 一律由 `writeProfile` 重算（导入 meta 仅作建议）。

### 5.4 `profile-cli.mjs`（纯核心 + 薄 shim）
- **纯核心** `run(argv, deps) -> { code, stdout, stderr }`，`deps = { store, importer, listChromeProfiles, isTTY, prompt, readFile, statFile }`（默认实现为真实依赖）。**薄 shim**：调用 `run`，写 stdout/stderr，`process.exit(code)`。所有 `process.exit`/console/TTY 只在 shim。
- **退出码**：`0` 成功；`2` 用户错误（参数缺失/未找到/校验失败/格式错误/冲突）；`1` 意外错误。
- **`--porcelain` 契约**（被 bash 依赖）：无表头、字面 `\t` 分隔、固定列序、空字段输出空串、每记录一行。
  - `list --porcelain`: `name\torigin\tsourceChromeProfile\trefreshedAt\thasSession`
  - `chrome --porcelain`: `profile\tname\temail\thasLogin`
- 子命令：
  - `list` / `chrome`（含 `--porcelain`）
  - `add [name] [--from <chromeProfile>] [--force]`：缺 `name`/`--from` 且 TTY → 交互（菜单选 Chrome profile + 输入名字）；`--from` 指向不存在/无 Cookies 的 profile → 错（2）；名字已存在且无 `--force` → 错（2，提示用 refresh 或 --force）；提取无 sessionid → 告警仍存（`hasSession=false`）。
  - `refresh <name> [--force]`：触发钥匙串；`meta.sourceChromeProfile` 为空（imported）→ 错（2，无 Chrome 来源）；**若重新提取无 sessionid，默认拒绝覆盖、保留旧 cookie 并告警**，`--force` 才覆盖。
  - `rename <old> <new>` / `delete <name> [--yes]`（TTY 下 y/N 确认，`--yes` 跳过；非 TTY 直接删）。
  - `backup <name> [path]` / `import <file> [name] [--force]`（别名 `restore`）：备份格式 name 取 `arg > meta.name`（校验）、**保留嵌入 meta（origin/sourceChromeProfile）**仅重算 count/hasSession；扩展格式必须给 `name`（否则 2）、`origin:"imported"`；name 冲突且无 `--force` → 错（2）；无 sessionid → 告警。
  - `exists <name>`：存在 → 0，否则 → 2（供 `start <name>` 预校验）。
  - `pick-start`：TTY 交互选已保存 profile，**仅把所选 name 打到 stdout**（提示走 stderr）；空存储 / 非 TTY / 用户取消(EOF/Ctrl-C/非法选择) → **非 0 退出且 stdout 为空**。
  - `ps-profile <cmdline>`：纯解析——从一条命令行字符串里取 `--profile` 后紧跟的 token，打到 stdout（无则空、退 0）。供 bash 调用，避免在 bash 里写正则。

### 5.5 `index.mjs`（修复签名冲突）
```js
const realDeps = { loadProfileCookies, getChromeTikTokCookies };
export async function getConfiguredCookies(deps = realDeps) {
  if (process.env.TIKTOK_PROFILE) return deps.loadProfileCookies(process.env.TIKTOK_PROFILE);
  return deps.getChromeTikTokCookies({ profile: process.env.CHROME_PROFILE });
}
```
- 钩子内改为 **`const cookies = await getCookies();`（无参）**；默认 `getCookies = getConfiguredCookies`。现有 DI 测试传入的 `getCookies` 忽略参数，仍兼容。
- 注入日志的"登录态"用 `SESSION_COOKIE_NAMES`。加载失败（如 profile 不存在抛错）由现有 try/catch → 告警 + 回退匿名。

### 5.6 `auth-server.mjs`
- 导出纯 `parseProfileArg(argv) -> name|undefined`（解析 `--profile <name>` / `--profile=<name>`）。
- 启动时若解析到 name → `process.env.TIKTOK_PROFILE = name`（在 `installAuthHook` 之前；env-file 已先于用户代码加载，故 argv 永远压过 `.env`）。其余（try/catch install + import server.mjs）不变。

### 5.7 `tiktokctl.sh`
- `profile <sub> [args…]` → `exec node tiktok-auth/profile-cli.mjs <sub> "$@"`（透传，保留子进程退出码 0/1/2）。
- **`start [name]`**（先解析"有效 profile 名"，再启动，且**总是显式传 `--profile`**，使 ps 可靠携带）：
  - 先 `is_running` 守卫：若已运行，用 `ps-profile` 取当前账号；给的 name 与当前不同 → 打印"已作为 <X> 运行 (pid N)；用 restart <name> 切换"并**非 0 退出**；相同 → 打印"已以 <name> 运行"退 0。
  - 有 `name` → `profile-cli exists <name>`，不存在 → `list` + 退 2；存在 → 以 `--profile "$name"` 启动。
  - 无 `name` 且 TTY → `name="$(node profile-cli pick-start)" || exit $?`，再判非空。
  - 无 `name` 且非 TTY → 解析回退：`.env` 的 `TIKTOK_PROFILE`（有则 `--profile` 之）→ 否则 `.env` 的 `CHROME_PROFILE`（旧实时模式，**不**传 `--profile`，由 auth-server 走回退）→ 都没有则报错退 2 提示先 `profile add`。
  - 启动：`nohup node --env-file-if-exists=.env auth-server.mjs ${profile:+--profile "$profile"} >> "$LOG_FILE" 2>&1 &`。
  - `TIKTOKCTL_DRY_RUN=1` → 不 spawn，回显将执行的命令字符串（供 bash 冒烟测试断言）。
- **`status`**：运行中用 `ps -o command= -p <pid>` → `profile-cli ps-profile "<cmdline>"` 取当前账号；为空则读 `.env` `TIKTOK_PROFILE`/`CHROME_PROFILE`。显示账号 + curl /health。`0` 运行 / `3` 未运行。
- **`restart [name]`**：**先在停止前解析目标**——有 `name` → 用它；否则从存活 pid 的 `ps` 取 `--profile`；再否则 `.env` `TIKTOK_PROFILE`/`CHROME_PROFILE`。**若解析不到目标，则不停止、退 2 提示**。解析到后再 `stop; start <目标>`。
- `stop` / `log`：同现状。

## 6. 运行时注入流程

```
tiktokctl start work
  → 解析有效 profile=work（exists 预校验）
  → nohup node ... auth-server.mjs --profile work
      → parseProfileArg → process.env.TIKTOK_PROFILE="work"
      → installAuthHook(puppeteer)            (默认 getCookies=getConfiguredCookies)
      → import server.mjs → newPage
          → getCookies()  (无参)
              → getConfiguredCookies(): TIKTOK_PROFILE 有 → loadProfileCookies("work")  # 读磁盘
                                         否则 → getChromeTikTokCookies({profile:CHROME_PROFILE})  # 旧回退
          → page.setCookie(...)
```
**自动会话刷新交互（已核实 `server.mjs:539-542`）**：服务每 ~30 分钟 / 500 次会 `closeBrowser→initBrowser→newPage→钩子`，从而**再次读取 `cookies.json`**。含义见 §8。

## 7. 账号切换语义
- 一次一个实例。`restart <other>` = （解析目标后）stop（server 优雅关闭清空 `.chrome-profile`）+ start（加载新 profile）。
- `start` 在已运行时按 §5.7 守卫处理（不同账号 → 提示 restart 切换；相同 → no-op 退 0）。

## 8. 错误处理与并发矩阵

| 情况 | 处理 |
|---|---|
| `start <name>` profile 不存在 | `list` + 退 2 |
| 存储为空 `start`（菜单/非交互） | 提示先 `profile add`，退 2 |
| `start` 已运行且 name 与当前不同 | 提示用 `restart` 切换，非 0 退出（不误 no-op） |
| `restart` 解析不到目标 | **不停止**、退 2 提示 |
| `add` 名字已存在（无 --force） | 退 2，提示 refresh 或 --force（防静默覆盖） |
| `add --from` 指向不存在/无 Cookies 的 Chrome profile | 退 2 |
| `add`/`import` 提取/文件无 sessionid | 告警；`hasSession=false`（仍保存） |
| `refresh` imported(无 source) | 退 2（无 Chrome 来源） |
| `refresh` 重新提取无 sessionid | 默认拒绝覆盖、保留旧 cookie 并告警；`--force` 才覆盖 |
| `import` JSON 损坏/未识别/无有效 cookie/超 5MB/扩展未给 name/名字冲突无 --force | 退 2 |
| `rename` 目标已存在/非法名 | 退 2 |
| `delete`/`backup`/`refresh` 不存在 | 退 2 |
| 运行中 `profile refresh <当前>` | 在**下次自动会话刷新**时生效（不立即）；文档说明 |
| 运行中 `profile delete <当前>` | 下次自动刷新时 `loadProfileCookies` 抛 → 钩子回退匿名（已知行为，文档说明） |
| 运行中 `rename/delete <当前>` | 允许；告警"运行中的服务仍服务旧 cookie 直到 stop/restart"；`restart` 一个已删除的 profile → 退 2 提示重新 add 或换一个 |
| 注入时 profile 读取失败 | 钩子 try/catch → 告警 + 回退匿名（不崩） |
| 加载的会话已过期 | 不主动判定；表现为匿名/未授权；`list` 显示 `refreshedAt` 供判断 |
| 并发：服务读 cookies.json 与 CLI 写 | `writeProfile` 原子（temp+fsync+rename），读者永不见半成品；delete/rename 运行中为尽力而为，退化为匿名回退 |

## 9. 安全
- `sessionid` = 账号完全访问权限。持久化文件 0600、目录 0700、存仓库外、绝不进 git。
- **创建即生效的权限**（防 umask 窗口）+ **原子写**（temp→fsync→rename，无可读窗口/防符号链接重定向）+ **`O_EXCL|O_NOFOLLOW`**（防预置符号链接劫持）。
- **路径穿越防护**：锚定 name 正则 + 拒绝 `.`/`..` + 拼接后 `path.resolve` 前缀校验。
- **符号链接防护**：操作前 `lstat(baseDir)` 拒绝符号链接/非属主；写用 `O_NOFOLLOW`；delete 前 `lstat` 目标 + 前缀校验。
- **不可信导入**：大小上限 5MB、字段白名单、跳过 `__proto__`/`constructor`/`prototype`（防原型污染/DoS）。
- 备份/导出文件含凭据：一律 0600、默认不落 git 工作树、README 提醒妥善保管。
- 日志只打数量/名字/登录布尔，绝不打印 cookie 值。
- 仅**读取**真实 Chrome profile。

## 10. 测试策略（新测试置于 `tiktok-auth/__tests__/`，无需改 jest 配置/package.json）
- `profile-store.test.mjs`：`TIKTOK_SIG_AUTH_HOME` 指临时目录；write/read/list/rename/delete/backup 往返；**`umask(0o000)` 包裹后断言 `stat.mode & 0o777` == 文件 0600 / base、profiles/、profiles/<name>/、backups/ 各 0700**；非法名/穿越名抛错；不存在抛错；原子写（中途不产生半文件，可用 rename 行为验证）。
- `cookie-import.test.mjs`：扩展数组→映射（expirationDate→expires、session→省略、sameSite 归一化、tiktok 过滤）；备份对象→{cookies,meta}（保留 origin/source）；坏 JSON/未识别→抛；`__proto__` 载荷不污染 `Object.prototype`；超限大小被拒（注入 `statFile` 假值）。
- `chrome-cookies.test.mjs`（追加）：`parseLocalStateNames` 解析 + 坏 JSON→`{}`；`listChromeProfiles` 用假 `chromeDir`（mkdtemp + 空 Cookies 文件 + Local State JSON）+ 注入 `hasLogin` 桩，断言枚举/合并/跳过/不抛（无需 sqlite3）。
- `cli.test.mjs`（`profile-cli` 纯核心 `run(argv, deps)`）：missing-name→2、not-found→2、rename 冲突→2、import 扩展无 name→2、add 名字冲突→2、`pick-start` 空存储→非 0 且 stdout 空、`pick-start` 选中只输出 name、`ps-profile` 解析（含无 --profile→空）、`exists` 0/2。
- `launcher.test.mjs`（追加）：把 `getConfiguredCookies` **作为 installAuthHook 的默认 getter 经钩子调用**，设 `TIKTOK_PROFILE` 时断言走 `loadProfileCookies`（注入 deps），不设时走 `getChromeTikTokCookies`；`parseProfileArg(argv)` 纯函数用例（`--profile x` / `--profile=x` / 无）。
- bash 冒烟：`TIKTOKCTL_DRY_RUN=1 ./tiktokctl.sh start work` 断言组装的命令含 `--profile work`；`profile` 透传退出码；`status` 的 ps→ps-profile 解析路径。
- 回归：`npm test` 全过；旧 `CHROME_PROFILE` 实时回退路径仍工作；现有 3 个 launcher 测试不破。

## 11. 退出码契约（两层）
- `profile-cli`：`0` 成功 / `2` 用户错误 / `1` 意外。
- `tiktokctl`：`profile` 透传保留子进程码；`start`/`restart` 用 `2` 表用户错误；`status` `0`=运行、`3`=未运行；用法错误 `2`。

## 12. 明确不做（YAGNI）
- 不做同时多实例（一次一个）。
- 导入只支持 备份文件 + 扩展 JSON 两种。
- 不自动判定/刷新过期会话（手动 `refresh`）。
- 不抓取展示 TikTok 用户名（用命名区分；可后续增强）。
- 不改 `server.mjs` / `xgnarly.mjs` / `package.json` / `.gitignore` / 根 `__tests__/`。`tiktok-auth/__tests__/` 属本 add-on，可扩展（含修改 `launcher.test.mjs`）。
