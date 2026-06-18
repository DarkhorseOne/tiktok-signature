import { run } from "../profile-cli.mjs";

function makeDeps(over = {}) {
  return {
    store: {
      listProfiles: () => [],
      profileExists: () => false,
      ...(over.store || {}),
    },
    listChromeProfiles: () => [],
    isTTY: false,
    prompt: async () => "",
    readFile: () => "",
    statFile: () => ({ size: 0 }),
    getChromeTikTokCookies: async () => [],
    fetchIdentity: async () => null,
    ...over,
  };
}

describe("run routing", () => {
  test("unknown command -> code 2 + usage", async () => {
    const r = await run(["bogus"], makeDeps());
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });

  test("list --porcelain prints TSV rows, no header", async () => {
    const deps = makeDeps({
      store: {
        listProfiles: () => [
          { name: "work", meta: { origin: "chrome", sourceChromeProfile: "Profile 1", refreshedAt: "2026-06-16T00:00:00.000Z", hasSession: true } },
          { name: "play", meta: { origin: "imported", sourceChromeProfile: null, refreshedAt: "2026-06-16T00:00:00.000Z", hasSession: false } },
        ],
      },
    });
    const r = await run(["list", "--porcelain"], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "work\tchrome\tProfile 1\t2026-06-16T00:00:00.000Z\ttrue\n" +
        "play\timported\t\t2026-06-16T00:00:00.000Z\tfalse\n",
    );
  });

  test("chrome --porcelain prints profile rows", async () => {
    const deps = makeDeps({
      listChromeProfiles: () => [{ profile: "Default", hasLogin: true, name: "Me", email: "m@x.com" }],
    });
    const r = await run(["chrome", "--porcelain"], deps);
    expect(r.stdout).toBe("Default\tMe\tm@x.com\ttrue\n");
  });

  test("exists -> 0 if present, 2 if not", async () => {
    expect((await run(["exists", "work"], makeDeps({ store: { profileExists: (n) => n === "work" } }))).code).toBe(0);
    expect((await run(["exists", "ghost"], makeDeps({ store: { profileExists: () => false } }))).code).toBe(2);
  });

  test("ps-profile extracts --profile token", async () => {
    // run() returns the raw name; the shim adds the trailing newline for bash.
    const r = await run(["ps-profile", "node --env-file auth-server.mjs --profile work"], makeDeps());
    expect(r.stdout).toBe("work");
    const r2 = await run(["ps-profile", "node auth-server.mjs"], makeDeps());
    expect(r2.stdout).toBe("");
  });
});

describe("add / refresh", () => {
  function depsWith(over) {
    const saved = {};
    const base = makeDeps({
      store: {
        profileExists: (n) => Object.prototype.hasOwnProperty.call(saved, n),
        writeProfile: (n, cookies, meta) => { saved[n] = { cookies, meta }; return { name: n, ...meta }; },
        readProfile: (n) => { if (!saved[n]) throw new Error(`profile not found: ${n}`); return { meta: { name: n, ...saved[n].meta }, cookies: saved[n].cookies }; },
      },
      listChromeProfiles: () => [{ profile: "Profile 1" }, { profile: "Default" }],
      getChromeTikTokCookies: async () => [{ name: "sessionid", value: "s", domain: ".tiktok.com" }],
      ...over,
    });
    base.__saved = saved;
    return base;
  }

  test("add <name> --from <chrome> extracts + saves", async () => {
    const deps = depsWith();
    const r = await run(["add", "work", "--from", "Profile 1"], deps);
    expect(r.code).toBe(0);
    expect(deps.__saved.work.meta).toMatchObject({ origin: "chrome", sourceChromeProfile: "Profile 1" });
    expect(deps.__saved.work.cookies[0].name).toBe("sessionid");
  });

  test("add existing name without --force -> 2", async () => {
    const deps = depsWith();
    await run(["add", "work", "--from", "Default"], deps);
    const r = await run(["add", "work", "--from", "Default"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/exists/i);
  });

  test("add --from with no extracted cookies -> 2", async () => {
    const deps = depsWith({ getChromeTikTokCookies: async () => [] });
    const r = await run(["add", "work", "--from", "Default"], deps);
    expect(r.code).toBe(2);
  });

  test("refresh imported (no source) -> 2", async () => {
    const deps = depsWith();
    deps.__saved.imp = { cookies: [], meta: { origin: "imported", sourceChromeProfile: null } };
    const r = await run(["refresh", "imp"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/source/i);
  });

  test("refresh re-extracts from source", async () => {
    const deps = depsWith();
    await run(["add", "work", "--from", "Profile 1"], deps);
    const r = await run(["refresh", "work"], deps);
    expect(r.code).toBe(0);
  });

  test("refresh without a session cookie keeps existing (no overwrite)", async () => {
    const deps = depsWith({ getChromeTikTokCookies: async () => [{ name: "foo", domain: ".tiktok.com" }] });
    deps.__saved.work = { cookies: [{ name: "sessionid", value: "old" }], meta: { origin: "chrome", sourceChromeProfile: "Default" } };
    const r = await run(["refresh", "work"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/kept existing/i);
    expect(deps.__saved.work.cookies).toEqual([{ name: "sessionid", value: "old" }]);
  });

  test("refresh --force overwrites even without a session cookie", async () => {
    const deps = depsWith({ getChromeTikTokCookies: async () => [{ name: "foo", domain: ".tiktok.com" }] });
    deps.__saved.work = { cookies: [{ name: "sessionid", value: "old" }], meta: { origin: "chrome", sourceChromeProfile: "Default" } };
    const r = await run(["refresh", "work", "--force"], deps);
    expect(r.code).toBe(0);
    expect(deps.__saved.work.cookies).toEqual([{ name: "foo", domain: ".tiktok.com" }]);
  });

  test("refresh treats sessionid_ss as a valid session (SESSION_COOKIE_NAMES)", async () => {
    const deps = depsWith({ getChromeTikTokCookies: async () => [{ name: "sessionid_ss", domain: ".tiktok.com" }] });
    deps.__saved.work = { cookies: [{ name: "sessionid" }], meta: { origin: "chrome", sourceChromeProfile: "Default" } };
    const r = await run(["refresh", "work"], deps);
    expect(r.code).toBe(0);
  });
});

describe("add auto-detect + identity", () => {
  function addDeps(over) {
    const saved = {};
    const deps = makeDeps({
      store: {
        profileExists: (n) => Object.prototype.hasOwnProperty.call(saved, n),
        writeProfile: (n, cookies, meta) => { saved[n] = { cookies, meta }; return { name: n, ...meta, hasSession: true }; },
      },
      getChromeTikTokCookies: async () => [{ name: "sessionid", domain: ".tiktok.com" }],
      ...over,
    });
    deps.__saved = saved;
    return deps;
  }

  test("auto-uses the single logged-in Chrome profile and names by @username", async () => {
    const deps = addDeps({
      listChromeProfiles: () => [{ profile: "Default", hasLogin: true }, { profile: "Profile 1", hasLogin: false }],
      fetchIdentity: async () => ({ username: "nickma2026", screenName: "马剑873", userId: "765" }),
    });
    const r = await run(["add"], deps);
    expect(r.code).toBe(0);
    expect(deps.__saved.nickma2026).toBeDefined();
    expect(deps.__saved.nickma2026.meta).toMatchObject({ sourceChromeProfile: "Default", tiktokUsername: "nickma2026", tiktokUserId: "765" });
  });

  test("errors when no Chrome profile is logged into TikTok", async () => {
    const deps = addDeps({ listChromeProfiles: () => [{ profile: "Default", hasLogin: false }] });
    const r = await run(["add"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/没有已登录|logged/i);
  });

  test("multiple logged-in + non-TTY requires --from", async () => {
    const deps = addDeps({ isTTY: false, listChromeProfiles: () => [{ profile: "Default", hasLogin: true }, { profile: "Profile 1", hasLogin: true }] });
    const r = await run(["add"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--from/);
  });

  test("no name + identity capture fails + non-TTY -> error", async () => {
    const deps = addDeps({ isTTY: false, listChromeProfiles: () => [{ profile: "Default", hasLogin: true }], fetchIdentity: async () => null });
    const r = await run(["add"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/name required/i);
  });

  test("explicit name overrides @username but identity is still stored", async () => {
    const deps = addDeps({
      listChromeProfiles: () => [{ profile: "Default", hasLogin: true }],
      fetchIdentity: async () => ({ username: "nickma2026", screenName: "x", userId: "765" }),
    });
    const r = await run(["add", "work"], deps);
    expect(r.code).toBe(0);
    expect(deps.__saved.work.meta).toMatchObject({ tiktokUsername: "nickma2026", tiktokUserId: "765" });
  });
});

describe("refresh account-changed guard", () => {
  function refDeps(over) {
    const saved = { acct: { cookies: [{ name: "sessionid" }], meta: { origin: "chrome", sourceChromeProfile: "Default", tiktokUserId: "111", tiktokUsername: "a" } } };
    let writtenMeta = null;
    const deps = makeDeps({
      store: {
        readProfile: (n) => { if (!saved[n]) throw new Error("nf"); return { meta: { name: n, ...saved[n].meta }, cookies: saved[n].cookies }; },
        writeProfile: (n, c, m) => { writtenMeta = m; saved[n] = { cookies: c, meta: { ...saved[n].meta, ...m } }; return { name: n }; },
      },
      getChromeTikTokCookies: async () => [{ name: "sessionid", domain: ".tiktok.com" }],
      ...over,
    });
    deps.__saved = saved;
    deps.__written = () => writtenMeta;
    return deps;
  }

  test("refuses when active TikTok account changed (userId mismatch)", async () => {
    const deps = refDeps({ fetchIdentity: async () => ({ username: "b", screenName: "", userId: "222" }) });
    const r = await run(["refresh", "acct"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/changed|replace/i);
    expect(deps.__written()).toBeNull(); // writeProfile NOT called
  });

  test("--force overrides the account-changed guard", async () => {
    const deps = refDeps({ fetchIdentity: async () => ({ username: "b", screenName: "", userId: "222" }) });
    const r = await run(["refresh", "acct", "--force"], deps);
    expect(r.code).toBe(0);
    expect(deps.__written().tiktokUserId).toBe("222");
  });

  test("same account refreshes normally", async () => {
    const deps = refDeps({ fetchIdentity: async () => ({ username: "a", screenName: "", userId: "111" }) });
    const r = await run(["refresh", "acct"], deps);
    expect(r.code).toBe(0);
    expect(deps.__written().tiktokUserId).toBe("111");
  });

  test("identity capture failure passes undefined (store preserves)", async () => {
    const deps = refDeps({ fetchIdentity: async () => null });
    const r = await run(["refresh", "acct"], deps);
    expect(r.code).toBe(0);
    expect(deps.__written().tiktokUserId).toBeUndefined();
  });
});

describe("rename / delete / backup / import / pick-start", () => {
  function storeMock(initial = {}) {
    const saved = { ...initial };
    return {
      saved,
      profileExists: (n) => Object.prototype.hasOwnProperty.call(saved, n),
      writeProfile: (n, cookies, meta) => { saved[n] = { cookies, meta }; return { name: n, ...meta }; },
      readProfile: (n) => { if (!saved[n]) throw new Error("nf"); return { meta: { name: n, ...(saved[n].meta || {}) }, cookies: saved[n].cookies || [] }; },
      listProfiles: () => Object.keys(saved).sort().map((n) => ({ name: n, meta: { origin: "chrome", sourceChromeProfile: "x", refreshedAt: "t", hasSession: true, ...(saved[n].meta || {}) } })),
      renameProfile: (o, x) => { if (saved[x]) throw new Error("already exists"); saved[x] = saved[o]; delete saved[o]; },
      deleteProfile: (n) => { if (!saved[n]) throw new Error("profile not found"); delete saved[n]; },
      backupProfile: (n, dest) => dest || `/bk/${n}.json`,
    };
  }

  test("rename ok; collision -> 2", async () => {
    const store = storeMock({ a: { cookies: [] }, b: { cookies: [] } });
    expect((await run(["rename", "a", "c"], makeDeps({ store }))).code).toBe(0);
    expect(store.saved.c).toBeDefined();
    expect((await run(["rename", "c", "b"], makeDeps({ store }))).code).toBe(2);
  });

  test("delete with --yes (non-interactive)", async () => {
    const store = storeMock({ a: { cookies: [] } });
    expect((await run(["delete", "a", "--yes"], makeDeps({ store, isTTY: false }))).code).toBe(0);
    expect(store.saved.a).toBeUndefined();
  });

  test("backup prints dest", async () => {
    const store = storeMock({ a: { cookies: [] } });
    const r = await run(["backup", "a"], makeDeps({ store }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/a\.json/);
  });

  test("import extension without name -> 2", async () => {
    const deps = makeDeps({
      store: storeMock(),
      importer: { parseImportFile: () => ({ cookies: [{ name: "sessionid", domain: ".tiktok.com" }] }) },
      readFile: () => "[]",
      statFile: () => ({ size: 10 }),
    });
    const r = await run(["import", "/tmp/x.json"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/name/i);
  });

  test("import backup with explicit name preserves origin/source", async () => {
    const store = storeMock();
    const deps = makeDeps({
      store,
      importer: { parseImportFile: () => ({ cookies: [{ name: "sessionid", domain: ".tiktok.com" }], meta: { origin: "chrome", sourceChromeProfile: "Profile 1" } }) },
      readFile: () => "{}",
      statFile: () => ({ size: 10 }),
    });
    const r = await run(["import", "/tmp/bk.json", "restored"], deps);
    expect(r.code).toBe(0);
    expect(store.saved.restored.meta).toMatchObject({ origin: "chrome", sourceChromeProfile: "Profile 1" });
  });

  test("import oversize -> 2", async () => {
    const deps = makeDeps({ store: storeMock(), readFile: () => "[]", statFile: () => ({ size: 6 * 1024 * 1024 }) });
    const r = await run(["import", "/tmp/big.json", "work"], deps);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/too large|size/i);
  });

  test("pick-start: empty store -> non-zero, empty stdout", async () => {
    const r = await run(["pick-start"], makeDeps({ store: storeMock(), isTTY: true }));
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  test("pick-start: prints chosen name only on stdout", async () => {
    const store = storeMock({ work: { cookies: [] }, play: { cookies: [] } });
    const deps = makeDeps({ store, isTTY: true, prompt: async () => "2" });
    const r = await run(["pick-start"], deps);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("work"); // 排序后 [play, work] 的第 2 个是 work；run() 不带换行
  });
});
