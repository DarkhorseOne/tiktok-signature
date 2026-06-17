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
