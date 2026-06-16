const SAME_SITE = { no_restriction: "None", lax: "Lax", strict: "Strict" };
const DANGER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) {
    if (DANGER_KEYS.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function mapExtensionCookie(c) {
  if (!c || typeof c !== "object") return null;
  const domain = typeof c.domain === "string" ? c.domain : "";
  if (!domain.endsWith("tiktok.com")) return null;
  const out = {
    name: String(c.name ?? ""),
    value: String(c.value ?? ""),
    domain,
    path: typeof c.path === "string" ? c.path : "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  const ss = SAME_SITE[String(c.sameSite || "").toLowerCase()];
  if (ss) out.sameSite = ss;
  if (c.session !== true && typeof c.expirationDate === "number") {
    out.expires = Math.floor(c.expirationDate);
  }
  return out;
}

function sanitizeBackupCookie(c) {
  const o = pick(c, ["name", "value", "domain", "path", "secure", "httpOnly", "expires", "sameSite"]);
  if (!o.name || !o.domain) return null;
  o.secure = !!o.secure;
  o.httpOnly = !!o.httpOnly;
  if (o.path == null) o.path = "/";
  if (o.expires != null && typeof o.expires !== "number") delete o.expires;
  return o;
}

function sanitizeMeta(m) {
  return pick(m, ["origin", "sourceChromeProfile"]);
}

/**
 * 解析导入文件内容（已由调用方做大小上限校验）。
 * 顶层数组 -> 扩展格式 {cookies}；含 cookies 数组的对象 -> 备份格式 {cookies, meta}。
 */
export function parseImportFile(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error("import file is not valid JSON");
  }
  if (Array.isArray(data)) {
    const cookies = data.map(mapExtensionCookie).filter(Boolean);
    if (!cookies.length) throw new Error("no tiktok.com cookies found in import file");
    return { cookies };
  }
  if (data && typeof data === "object" && Array.isArray(data.cookies)) {
    const cookies = data.cookies.map(sanitizeBackupCookie).filter(Boolean);
    if (!cookies.length) throw new Error("backup contains no cookies");
    return { cookies, meta: sanitizeMeta(data.meta) };
  }
  throw new Error("unrecognized import format");
}
