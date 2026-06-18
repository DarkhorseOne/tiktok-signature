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
  deleteProfile,
  renameProfile,
  backupProfile,
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

describe("delete / rename / backup", () => {
  test("deleteProfile removes; missing throws", () => {
    writeProfile("work", COOKIES, {});
    deleteProfile("work");
    expect(profileExists("work")).toBe(false);
    expect(() => deleteProfile("work")).toThrow(/profile not found/);
  });

  test("renameProfile moves dir + updates meta.name; collision throws", () => {
    writeProfile("old", COOKIES, { origin: "chrome", sourceChromeProfile: "Default" });
    renameProfile("old", "new");
    expect(profileExists("old")).toBe(false);
    expect(readProfile("new").meta.name).toBe("new");
    expect(readProfile("new").meta.sourceChromeProfile).toBe("Default");
    writeProfile("other", COOKIES, {});
    expect(() => renameProfile("new", "other")).toThrow(/already exists/);
  });

  test("backupProfile default location writes a 0600 backup file with payload", () => {
    writeProfile("work", COOKIES, { origin: "chrome", sourceChromeProfile: "Default" });
    const dest = backupProfile("work");
    const j = JSON.parse(fs.readFileSync(dest, "utf8"));
    expect(j.type).toBe("tiktok-sig-auth-backup");
    expect(j.cookies).toEqual(COOKIES);
    expect(j.meta.sourceChromeProfile).toBe("Default");
    expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
  });

  test("backupProfile explicit dest refuses to overwrite", () => {
    writeProfile("work", COOKIES, {});
    const dest = path.join(home, "out", "bk.json");
    backupProfile("work", dest);
    expect(fs.existsSync(dest)).toBe(true);
    expect(() => backupProfile("work", dest)).toThrow(/already exists/);
  });
});

describe("tiktok identity fields", () => {
  test("writeProfile stores tiktok identity", () => {
    const meta = writeProfile("acct", COOKIES, { origin: "chrome", sourceChromeProfile: "Default", tiktokUsername: "u", tiktokScreenName: "s", tiktokUserId: "123" });
    expect(meta).toMatchObject({ tiktokUsername: "u", tiktokScreenName: "s", tiktokUserId: "123" });
    expect(readProfile("acct").meta.tiktokUserId).toBe("123");
  });
  test("undefined preserves existing identity; null clears it", () => {
    writeProfile("acct", COOKIES, { tiktokUsername: "u", tiktokUserId: "123" });
    const m1 = writeProfile("acct", COOKIES, { origin: "chrome", sourceChromeProfile: "Default" }); // omit -> preserve
    expect(m1.tiktokUsername).toBe("u");
    expect(m1.tiktokUserId).toBe("123");
    const m2 = writeProfile("acct", COOKIES, { tiktokUsername: null }); // explicit null -> clear
    expect(m2.tiktokUsername).toBeNull();
  });
  test("new profile without identity defaults to null", () => {
    const meta = writeProfile("fresh", COOKIES, { origin: "chrome", sourceChromeProfile: "Default" });
    expect(meta.tiktokUsername).toBeNull();
    expect(meta.tiktokUserId).toBeNull();
  });
});

describe("security guards", () => {
  test("secureMkdir/secureWriteFile tighten pre-existing loose perms", () => {
    const dir = path.join(home, "profiles", "loose");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(home, 0o777);
    fs.chmodSync(path.join(home, "profiles"), 0o777);
    fs.chmodSync(dir, 0o777);
    writeProfile("loose", COOKIES, {});
    const m = (p) => fs.statSync(p).mode & 0o777;
    expect(m(home)).toBe(0o700);
    expect(m(path.join(home, "profiles"))).toBe(0o700);
    expect(m(dir)).toBe(0o700);
    expect(m(path.join(dir, "cookies.json"))).toBe(0o600);
  });

  test("relative TIKTOK_SIG_AUTH_HOME is rejected", () => {
    process.env.TIKTOK_SIG_AUTH_HOME = "relative/dir";
    expect(() => writeProfile("x", COOKIES, {})).toThrow(/absolute/i);
    process.env.TIKTOK_SIG_AUTH_HOME = home;
  });

  test("symlinked base dir is rejected", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "ttreal-"));
    const link = path.join(os.tmpdir(), `ttlink-${process.pid}-${real.length}`);
    fs.symlinkSync(real, link);
    process.env.TIKTOK_SIG_AUTH_HOME = link;
    expect(() => writeProfile("x", COOKIES, {})).toThrow(/symlink/i);
    process.env.TIKTOK_SIG_AUTH_HOME = home;
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  });

  test("deleteProfile refuses a symlinked profile dir; target survives", () => {
    writeProfile("realone", COOKIES, {});
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "tttarget-"));
    const linkProfile = path.join(home, "profiles", "linked");
    fs.symlinkSync(target, linkProfile);
    expect(() => deleteProfile("linked")).toThrow(/symlink/i);
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(linkProfile, { force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
});
