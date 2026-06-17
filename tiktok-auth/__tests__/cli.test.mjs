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
