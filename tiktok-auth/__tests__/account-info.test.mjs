import { parseIdentity, fetchTikTokIdentity } from "../account-info.mjs";

describe("parseIdentity", () => {
  test("parses username/screen_name/user_id from account info JSON", () => {
    const text = JSON.stringify({ data: { username: "nick", screen_name: "Nick M", user_id_str: "765" }, message: "success" });
    expect(parseIdentity(text)).toEqual({ username: "nick", screenName: "Nick M", userId: "765" });
  });
  test("missing username -> null", () => {
    expect(parseIdentity(JSON.stringify({ data: { screen_name: "x" } }))).toBeNull();
  });
  test("bad JSON -> null", () => {
    expect(parseIdentity("not json")).toBeNull();
  });
});

describe("fetchTikTokIdentity", () => {
  const cookies = [{ name: "sessionid", value: "s" }];
  test("returns identity on 200 with valid body", async () => {
    const fakeReq = async () => ({ statusCode: 200, body: { text: async () => JSON.stringify({ data: { username: "nick", screen_name: "N", user_id_str: "1" } }) } });
    expect(await fetchTikTokIdentity(cookies, { request: fakeReq })).toEqual({ username: "nick", screenName: "N", userId: "1" });
  });
  test("non-200 -> null", async () => {
    const fakeReq = async () => ({ statusCode: 401, body: { text: async () => "" } });
    expect(await fetchTikTokIdentity(cookies, { request: fakeReq })).toBeNull();
  });
  test("request throws -> null", async () => {
    const fakeReq = async () => { throw new Error("net"); };
    expect(await fetchTikTokIdentity(cookies, { request: fakeReq })).toBeNull();
  });
  test("no cookies -> null", async () => {
    let called = false;
    const fakeReq = async () => { called = true; return { statusCode: 200, body: { text: async () => "" } }; };
    expect(await fetchTikTokIdentity([], { request: fakeReq })).toBeNull();
    expect(called).toBe(false);
  });
});
