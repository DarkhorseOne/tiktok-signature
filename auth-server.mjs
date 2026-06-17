#!/usr/bin/env node
/**
 * 登录态启动入口（附加组件，不修改上游 server.mjs）。
 * 先给共享的 puppeteer-extra 单例装上 cookie 注入钩子，再 import 原 server.mjs 启动服务。
 * 用法: node --env-file-if-exists=.env auth-server.mjs   （或 ./tiktokctl.sh start）
 */
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
console.log(
  installed
    ? "[auth] 登录态注入已启用 (TIKTOK_AUTH_ENABLED=true)"
    : "[auth] 登录态注入未启用，匿名模式 (设置 TIKTOK_AUTH_ENABLED=true 开启)",
);

await import("./server.mjs");
