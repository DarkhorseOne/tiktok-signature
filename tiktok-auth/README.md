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
