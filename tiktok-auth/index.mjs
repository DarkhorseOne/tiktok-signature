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

  if (puppeteer.__authHookInstalled) return true;
  puppeteer.__authHookInstalled = true;

  const getCookies = options.getCookies || getChromeTikTokCookies;
  const origLaunch = puppeteer.launch.bind(puppeteer);

  puppeteer.launch = async (...args) => {
    const browser = await origLaunch(...args);
    const origNewPage = browser.newPage.bind(browser);
    browser.newPage = async (...pageArgs) => {
      const page = await origNewPage(...pageArgs);
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
