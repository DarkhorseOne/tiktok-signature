import { parseProfileArg } from "../parse-args.mjs";

describe("parseProfileArg", () => {
  test("--profile <name>", () => {
    expect(parseProfileArg(["--profile", "work"])).toBe("work");
  });
  test("--profile=<name>", () => {
    expect(parseProfileArg(["--profile=play"])).toBe("play");
  });
  test("absent -> undefined", () => {
    expect(parseProfileArg(["--other", "x"])).toBeUndefined();
    expect(parseProfileArg([])).toBeUndefined();
  });
});
