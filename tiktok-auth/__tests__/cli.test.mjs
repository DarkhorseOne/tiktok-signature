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
