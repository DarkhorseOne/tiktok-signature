import { installAuthHook } from "../index.mjs";

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
    await browser.newPage();
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
