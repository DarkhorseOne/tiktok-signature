# 账号为中心的 Profile 提取 — 设计文档

- 日期：2026-06-17
- 状态：待实现
- 平台：macOS（本机自用）
- 分支：`feature/account-centric-profiles`
- 前置：基于已合并的 [多账号 Profile 管理](2026-06-16-multi-account-profile-management-design.md)
- 核心约束：**不修改原项目任何已跟踪文件**（`server.mjs`/`xgnarly.mjs`/`package.json`/`.gitignore`/根 `__tests__/`），改动限于 add-on 文件

## 1. 背景与目标

现状：`profile add` 让用户先在 **Chrome profile（按 Google 账号标注）** 里选源，再起名。用户的真实用法是**一个 Chrome（Default）里换登多个 TikTok 账号**,逐个提取保存。让用户面对 Google 账号菜单是错误的心智模型。

目标:把 `add`/`refresh` 变成**以"当前 Chrome 里登录着的 TikTok 会话"为中心**:
1. `add` 自动定位已登录 TikTok 的 Chrome profile,免去 Google 账号选择。
2. 提取时自动抓取该会话的 **TikTok @用户名**,存入 profile,使列表按 TikTok 账号显示。
3. 名字默认用抓到的 @用户名 → `profile add`(零参数)即可保存当前会话。
4. `refresh` 用身份校验防止"抓错账号"覆盖。

已验证:用保存的 cookie 直接请求 `https://www.tiktok.com/passport/web/account/info/`(纯 cookie 鉴权,无需签名)返回 `username`/`screen_name`/`user_id`(HTTP 200),离线抓取可行。

## 2. 变更

### 2.1 `add` 自动定位已登录的 Chrome profile（去掉 Google 账号菜单）
`profile add [name] [--from <chromeProfile>] [--force]`:
- 无 `--from` 时,对 `listChromeProfiles()` 按 `hasLogin === true` 过滤:
  - 恰好 1 个 → 静默使用(你的情况:Default),**不弹菜单**。
  - 0 个 → 报错(退 2):`Chrome 里没有已登录 TikTok 的会话;请先在 Chrome 登录 TikTok`。
  - >1 个 → TTY 下弹菜单(**仅列已登录的**)选一个;非 TTY → 报错提示传 `--from`。
- 有 `--from` → 校验该 profile 存在于 `listChromeProfiles()`(否则退 2),强制用它。
- 删除旧的 `interactiveAdd`(它列出所有 Chrome profile 含未登录的);新增 `pickChromeProfile(rows, deps)` 仅在 >1 已登录时用。

### 2.2 抓取 TikTok 身份(新模块 `tiktok-auth/account-info.mjs`)
- `parseIdentity(text)`(纯函数):解析 account/info JSON → `{ username, screenName, userId }`;无 `data.username` 或坏 JSON → `null`。
- `fetchTikTokIdentity(cookies, { request, timeoutMs } = {})`:用 cookie 头 + Safari UA GET 该端点(undici,已是依赖),5s 超时,`maxRedirections: 0`;非 200/异常/解析失败 → `null`(尽力而为)。`request` 可注入便于测试。
- `add`/`refresh` 提取 cookie 后调用,把 `tiktokUsername`/`tiktokScreenName`/`tiktokUserId` 存入 meta;抓取失败 → 留空 + 告警,**仍保存**。

### 2.3 名字默认用 @用户名
- `add` 无 `name`:抓到用户名 → 用作 profile 名(TikTok 用户名字符 `[A-Za-z0-9._]` 均满足现有 `NAME_RE`);抓取失败且无名字 → TTY 提示输入,否则报错(退 2)。
- 有 `name` → 用它(仍把身份存入 meta)。名字冲突且无 `--force` → 退 2。

### 2.4 `refresh` 账号安全校验
- 重新提取后抓身份;若 profile 存了 `tiktokUserId` 且新抓到的 `userId` 不同且无 `--force` → **拒绝**(退 2):`refresh would replace @<old> with @<new>; the active TikTok account in Chrome changed. Switch back or use --force.`。
- 无存储身份 / 抓取失败 → 退回现有 `hasSessionCookie` 门控行为。
- 身份字段写回:`fetchIdentity` 成功 → 用新值;失败 → 传 `undefined` 让 `writeProfile` **保留原值**。

### 2.5 meta.json 新增字段
```json
{ "...": "现有字段", "tiktokUsername": "nickma2026", "tiktokScreenName": "马剑873", "tiktokUserId": "7650130039635362838" }
```
`writeProfile(name, cookies, metaIn)` 规则:对 `tiktokUsername`/`tiktokScreenName`/`tiktokUserId`,`metaIn` 显式给值(含 `null`)则用之;为 `undefined` 则**保留已存在 meta 的旧值**(与 `createdAt` 保留逻辑一致);新建且未给 → `null`。

### 2.6 `list` 显示
- 人类可读:有 `tiktokUsername` 时显示 `@<username> (<screenName>)`。
- `--porcelain`:列序改为 `name\torigin\tsourceChromeProfile\ttiktokUsername\trefreshedAt\thasSession`(在 sourceChromeProfile 后插入 tiktokUsername;空值输出空串)。当前无 bash 消费 `list --porcelain`,改列安全。

## 3. 组件（全为 add-on）

| 文件 | 改动 |
|---|---|
| `tiktok-auth/account-info.mjs` | 新建:`parseIdentity` + `fetchTikTokIdentity` |
| `tiktok-auth/profile-store.mjs` | `writeProfile` 透传/保留 `tiktok*` 字段 |
| `tiktok-auth/profile-cli.mjs` | `cmdAdd` 自动定位+名字默认+抓身份;`cmdRefresh` 抓身份+不一致拒绝;`pickChromeProfile` 替换 `interactiveAdd`;`cmdList` 显示用户名;`makeRealDeps` 加 `fetchIdentity` |
| `tiktok-auth/README.md` | 更新用法(add 不再需 --from;按 @用户名管理) |

## 4. 数据流(add)
```
profile add            (Chrome 当前登录 TikTok 账号 X)
 → listChromeProfiles().filter(hasLogin)  → 唯一 Default
 → getChromeTikTokCookies({profile:"Default"})  → cookies
 → fetchTikTokIdentity(cookies)  → {username:"X",...}  (尽力而为)
 → name = "X"  (无显式名字时)
 → writeProfile("X", cookies, {origin:"chrome", sourceChromeProfile:"Default", tiktokUsername:"X", ...})
```

## 5. 错误处理
| 情况 | 处理 |
|---|---|
| 无已登录 TikTok 的 Chrome profile | 退 2,提示先登录 |
| >1 已登录且非 TTY 且无 --from | 退 2,提示传 --from |
| `--from` 指向不存在/无 Cookies | 退 2 |
| 提取无 cookie / 无 sessionid | 无 cookie→退 2;无 sessionid→告警(仍存,hasSession=false) |
| 身份抓取失败(离线/过期/被拦) | 尽力而为:留空 + 告警,profile 仍保存;名字缺失且无法默认 → 退 2 |
| 无名字且抓不到用户名且非 TTY | 退 2 |
| 名字冲突无 --force | 退 2 |
| refresh:Chrome 当前 TikTok 账号已变(userId 不符)无 --force | 退 2,拒绝覆盖 |
| refresh:导入来源(无 sourceChromeProfile) | 退 2 |

## 6. 安全
- 身份抓取是对 TikTok 的**只读**出站请求,仅用本机已保存的 cookie;不打印 cookie 值;失败静默降级。
- 其余(存储 0600/0700、路径穿越/符号链接防护、精确 tiktok 域匹配)沿用现状,不放松。
- ⚠️ meta 含 `tiktokUserId`/用户名(非敏感),cookies 仍是敏感凭据。

## 7. 测试
- `account-info.test.mjs`:`parseIdentity`(合法→对象;无 username→null;坏 JSON→null);`fetchTikTokIdentity` 注入假 `request`(200+body→身份;非 200→null;抛错→null;无 cookie→null)。
- `cli.test.mjs` add:1 个已登录→静默用之并以用户名命名;0 个→退 2;>1 非 TTY→退 2;名字默认=抓到的用户名;身份写入 meta;抓取失败+无名+非 TTY→退 2;显式名字+冲突无 --force→退 2。
- `cli.test.mjs` refresh:storedUserId≠newUserId 无 --force→退 2 且不写;--force→写;抓取失败→保留原身份(writeProfile 收到 undefined)。
- `profile-store.test.mjs`:`writeProfile` 存 `tiktok*`;`undefined` 保留旧值、`null` 清空。
- 全部网络/Chrome 访问经依赖注入,单测不联网。
- 回归:`npm test` 全过;`start <name>` 注入路径不变。

## 8. 明确不做(YAGNI)
- 不改 `start`/注入逻辑、存储布局、`tiktokctl.sh` 控制流。
- 不做 TikTok 多账号 `multi_sids` 的逐账号拆分(只抓当前活跃账号)。
- 不联网重试/缓存身份;抓不到就留空。
- 不碰上游文件。
