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

## 多账号管理（profile）

每个 TikTok 账号对应一个 Chrome profile。把账号会话提取并持久化到 `~/.tiktok-sig-auth/`（仓库外，文件 0600），启动时选择加载哪个。

```bash
# 列出本机 Chrome profile（看哪个登录了 TikTok）
./tiktokctl.sh profile chrome

# 提取保存"当前 Chrome 里登录的 TikTok 账号"（自动定位已登录的 profile；自动以 @用户名命名）
./tiktokctl.sh profile add
# 在 Chrome 切换/重登另一个 TikTok 账号后，再次：
./tiktokctl.sh profile add
# （也可显式命名/指定来源）：./tiktokctl.sh profile add 别名 --from "Default"

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

`profile list` 按 TikTok @用户名显示已保存账号。`refresh` 会校验 Chrome 当前登录的 TikTok 账号是否与该 profile 一致，不一致会拒绝（除非 `--force`）。

注入源：设了账号（`--profile`/菜单）走持久化存储；否则回退到 `.env` 的 `CHROME_PROFILE` 实时模式。

⚠️ 保存的会话与备份文件含 `sessionid`（账号完全访问权限），权限 0600、存仓库外，**勿外传、勿放入同步盘/仓库**。
