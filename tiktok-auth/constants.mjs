/** TikTok 登录态的权威 cookie 名集合（hasLogin / hasSession / 注入日志 统一引用） */
export const SESSION_COOKIE_NAMES = ["sessionid", "sessionid_ss", "sid_guard"];

/** cookies 数组中是否含任一会话 cookie */
export function hasSessionCookie(cookies) {
  return (
    Array.isArray(cookies) &&
    cookies.some((c) => c && SESSION_COOKIE_NAMES.includes(c.name))
  );
}
