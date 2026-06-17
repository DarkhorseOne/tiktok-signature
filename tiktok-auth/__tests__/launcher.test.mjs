import fs from "fs";
import { installAuthHook, getConfiguredCookies } from "../index.mjs";

// 构造一个假的 puppeteer 单例：launch 返回带 newPage 的假 browser
function makeFakePuppeteer(events) {
  const fakePage = {
    setCookie: async (...cookies) => {
      events.push(["setCookie", cookies.length]);
    },
  };
  const fakeBrowser = {
    newPage: async () => {
      events.push(["newPage"]);
      return fakePage;
    },
  };
  return {
    launch: async () => {
      events.push(["launch"]);
      return fakeBrowser;
    },
  };
}

describe("installAuthHook", () => {
  test("disabled: returns false and does not wrap launch", async () => {
    const events = [];
    const pptr = makeFakePuppeteer(events);
    const before = pptr.launch;
    const installed = await installAuthHook(pptr, { enabled: false });
    expect(installed).toBe(false);
    expect(pptr.launch).toBe(before);
  });

  test("enabled: injects cookies on newPage before returning page", async () => {
    const events = [];
    const pptr = makeFakePuppeteer(events);
    const installed = await installAuthHook(pptr, {
      enabled: true,
      getCookies: async () => [
        { name: "sessionid", value: "x", domain: ".tiktok.com", path: "/" },
      ],
    });
    expect(installed).toBe(true);

    const browser = await pptr.launch();
    const page = await browser.newPage();
    expect(page).toBeDefined();
    expect(events).toEqual([["launch"], ["newPage"], ["setCookie", 1]]);
  });

  test("enabled but getCookies throws: still returns a page (anonymous fallback)", async () => {
    const events = [];
    const pptr = makeFakePuppeteer(events);
    await installAuthHook(pptr, {
      enabled: true,
      getCookies: async () => {
        throw new Error("boom");
      },
    });
    const browser = await pptr.launch();
    const page = await browser.newPage();
    expect(page).toBeDefined();
    expect(events).toEqual([["launch"], ["newPage"]]);
  });
});

describe("hook calls getCookies with NO args (signature-collision guard)", () => {
  test("getCookies invoked with zero arguments", async () => {
    const events = [];
    const pptr = makeFakePuppeteer(events);
    let argsSeen = "unset";
    await installAuthHook(pptr, {
      enabled: true,
      getCookies: async (...a) => {
        argsSeen = a;
        return [];
      },
    });
    const b = await pptr.launch();
    await b.newPage();
    expect(argsSeen).toEqual([]);
  });
});

describe("getConfiguredCookies dispatch", () => {
  afterEach(() => {
    delete process.env.TIKTOK_PROFILE;
    delete process.env.CHROME_PROFILE;
  });
  test("uses store loader when TIKTOK_PROFILE set", async () => {
    process.env.TIKTOK_PROFILE = "work";
    const calls = [];
    const deps = {
      loadProfileCookies: async (n) => { calls.push(["store", n]); return [{ name: "sessionid" }]; },
      getChromeTikTokCookies: async (o) => { calls.push(["chrome", o]); return []; },
    };
    const r = await getConfiguredCookies(deps);
    expect(calls).toEqual([["store", "work"]]);
    expect(r).toEqual([{ name: "sessionid" }]);
  });
  test("falls back to chrome live when TIKTOK_PROFILE unset", async () => {
    process.env.CHROME_PROFILE = "Profile 1";
    const calls = [];
    const deps = {
      loadProfileCookies: async () => { calls.push("store"); return []; },
      getChromeTikTokCookies: async (o) => { calls.push(["chrome", o]); return []; },
    };
    await getConfiguredCookies(deps);
    expect(calls).toEqual([["chrome", { profile: "Profile 1" }]]);
  });
});

describe("auth-server.mjs entry ordering", () => {
  const src = fs.readFileSync(
    new URL("../../auth-server.mjs", import.meta.url),
    "utf8",
  );

  test("imports installAuthHook", () => {
    expect(src).toMatch(/installAuthHook/);
  });

  test("installs hook before importing server.mjs", () => {
    const hookIdx = src.indexOf("installAuthHook(");
    const serverIdx = src.indexOf('import("./server.mjs")');
    expect(hookIdx).toBeGreaterThan(-1);
    expect(serverIdx).toBeGreaterThan(-1);
    expect(hookIdx).toBeLessThan(serverIdx);
  });
});
