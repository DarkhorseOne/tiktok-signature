import { parseImportFile } from "../cookie-import.mjs";

describe("parseImportFile - extension JSON array", () => {
  test("maps fields, normalizes sameSite, expirationDate->expires, filters non-tiktok", () => {
    const arr = JSON.stringify([
      { name: "sessionid", value: "s", domain: ".tiktok.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 1700000000.5 },
      { name: "sess2", value: "v", domain: ".tiktok.com", session: true, sameSite: "lax" },
      { name: "junk", value: "j", domain: ".google.com" },
    ]);
    const { cookies, meta } = parseImportFile(arr);
    expect(meta).toBeUndefined();
    expect(cookies).toEqual([
      { name: "sessionid", value: "s", domain: ".tiktok.com", path: "/", secure: true, httpOnly: true, sameSite: "None", expires: 1700000000 },
      { name: "sess2", value: "v", domain: ".tiktok.com", path: "/", secure: false, httpOnly: false, sameSite: "Lax" },
    ]);
  });
  test("no tiktok cookies -> throws", () => {
    expect(() => parseImportFile(JSON.stringify([{ name: "x", domain: ".google.com" }]))).toThrow(/no tiktok/i);
  });
});

describe("parseImportFile - backup object", () => {
  test("returns cookies + sanitized meta (origin/source preserved)", () => {
    const backup = JSON.stringify({
      type: "tiktok-sig-auth-backup",
      cookies: [{ name: "sessionid", value: "s", domain: ".tiktok.com", path: "/", secure: true, httpOnly: true }],
      meta: { origin: "chrome", sourceChromeProfile: "Profile 1", cookieCount: 999 },
    });
    const { cookies, meta } = parseImportFile(backup);
    expect(cookies[0].name).toBe("sessionid");
    expect(meta).toEqual({ origin: "chrome", sourceChromeProfile: "Profile 1" });
  });
});

describe("parseImportFile - safety", () => {
  test("bad JSON throws", () => {
    expect(() => parseImportFile("nope")).toThrow(/valid JSON/i);
  });
  test("unrecognized format throws", () => {
    expect(() => parseImportFile(JSON.stringify({ foo: 1 }))).toThrow(/unrecognized/i);
  });
  test("__proto__ payload does not pollute Object.prototype", () => {
    const evil = JSON.stringify([{ name: "sessionid", domain: ".tiktok.com", __proto__: { polluted: true } }]);
    parseImportFile(evil);
    expect({}.polluted).toBeUndefined();
  });
});
