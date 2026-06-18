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
