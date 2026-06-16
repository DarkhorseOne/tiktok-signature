import fs from "fs";
import os from "os";
import path from "path";
import {
  assertValidName,
  writeProfile,
  readProfile,
  loadProfileCookies,
  profileExists,
  listProfiles,
} from "../profile-store.mjs";

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ttsa-"));
  process.env.TIKTOK_SIG_AUTH_HOME = home;
});
afterEach(() => {
  delete process.env.TIKTOK_SIG_AUTH_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const COOKIES = [
  { name: "sessionid", value: "s", domain: ".tiktok.com", path: "/", secure: true, httpOnly: true },
];

describe("assertValidName", () => {
  test("accepts safe names", () => {
    expect(assertValidName("work-1.bak")).toBe("work-1.bak");
  });
  test("rejects traversal / dots / separators", () => {
    for (const bad of ["..", ".", "a/b", "../x", "a b", ""]) {
      expect(() => assertValidName(bad)).toThrow();
    }
  });
});

describe("writeProfile / readProfile", () => {
  test("round-trips cookies + derived meta", () => {
    const meta = writeProfile("work", COOKIES, { origin: "chrome", sourceChromeProfile: "Profile 1" });
    expect(meta.name).toBe("work");
    expect(meta.origin).toBe("chrome");
    expect(meta.sourceChromeProfile).toBe("Profile 1");
    expect(meta.cookieCount).toBe(1);
    expect(meta.hasSession).toBe(true);
    expect(meta.createdAt).toEqual(meta.refreshedAt);

    const { meta: m2, cookies } = readProfile("work");
    expect(cookies).toEqual(COOKIES);
    expect(m2).toEqual(meta);
    expect(loadProfileCookies("work")).toEqual(COOKIES);
    expect(profileExists("work")).toBe(true);
    expect(profileExists("nope")).toBe(false);
  });

  test("second write preserves createdAt, updates refreshedAt", async () => {
    const a = writeProfile("work", COOKIES, {});
    await new Promise((r) => setTimeout(r, 5));
    const b = writeProfile("work", COOKIES, {});
    expect(b.createdAt).toBe(a.createdAt);
    expect(new Date(b.refreshedAt).getTime()).toBeGreaterThanOrEqual(new Date(a.createdAt).getTime());
  });

  test("files are 0600 and dirs 0700 even under loose umask", () => {
    const old = process.umask(0o000);
    try {
      writeProfile("work", COOKIES, {});
    } finally {
      process.umask(old);
    }
    const fmode = (p) => fs.statSync(p).mode & 0o777;
    expect(fmode(path.join(home, "profiles", "work", "cookies.json"))).toBe(0o600);
    expect(fmode(path.join(home, "profiles", "work", "meta.json"))).toBe(0o600);
    expect(fmode(home)).toBe(0o700);
    expect(fmode(path.join(home, "profiles"))).toBe(0o700);
    expect(fmode(path.join(home, "profiles", "work"))).toBe(0o700);
  });

  test("readProfile throws for missing", () => {
    expect(() => readProfile("ghost")).toThrow(/profile not found/);
  });
});

describe("listProfiles", () => {
  test("sorted, skips dirs without meta", () => {
    writeProfile("b", COOKIES, {});
    writeProfile("a", COOKIES, {});
    fs.mkdirSync(path.join(home, "profiles", "junk"), { recursive: true });
    const names = listProfiles().map((p) => p.name);
    expect(names).toEqual(["a", "b"]);
  });
});
