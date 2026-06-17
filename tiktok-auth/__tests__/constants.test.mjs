import { SESSION_COOKIE_NAMES, hasSessionCookie } from "../constants.mjs";

describe("constants", () => {
  test("SESSION_COOKIE_NAMES is the canonical session set", () => {
    expect(SESSION_COOKIE_NAMES).toEqual(["sessionid", "sessionid_ss", "sid_guard"]);
  });
  test("hasSessionCookie true when any session cookie present", () => {
    expect(hasSessionCookie([{ name: "sid_guard" }, { name: "x" }])).toBe(true);
  });
  test("hasSessionCookie false when none present / not array", () => {
    expect(hasSessionCookie([{ name: "x" }])).toBe(false);
    expect(hasSessionCookie(null)).toBe(false);
  });
});
