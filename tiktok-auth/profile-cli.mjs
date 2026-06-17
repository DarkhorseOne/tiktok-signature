import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as store from "./profile-store.mjs";
import { parseImportFile } from "./cookie-import.mjs";
import { listChromeProfiles } from "./chrome-cookies.mjs";
import { getChromeTikTokCookies } from "./chrome-cookies.mjs";

const USAGE =
  "usage: profile-cli <list|chrome|add|refresh|rename|delete|backup|import|restore|exists|pick-start|ps-profile> [...]";

function ok(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}
function userErr(stderr) {
  return { code: 2, stdout: "", stderr };
}
function hasFlag(rest, f) {
  return rest.includes(f);
}
function positionals(rest) {
  return rest.filter((a) => !a.startsWith("--"));
}
function flagVal(rest, name) {
  const eq = rest.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

function cmdList(rest, deps) {
  const rows = deps.store.listProfiles();
  if (hasFlag(rest, "--porcelain")) {
    return ok(
      rows
        .map((p) =>
          [p.name, p.meta.origin, p.meta.sourceChromeProfile || "", p.meta.refreshedAt, String(!!p.meta.hasSession)].join("\t"),
        )
        .map((l) => l + "\n")
        .join(""),
    );
  }
  if (!rows.length) return ok("(no saved profiles; run `profile add`)");
  return ok(
    rows
      .map((p) => `${p.name}\t[${p.meta.origin}${p.meta.sourceChromeProfile ? " " + p.meta.sourceChromeProfile : ""}]\t${p.meta.refreshedAt}\t${p.meta.hasSession ? "✅" : "❌"}`)
      .join("\n"),
  );
}

function cmdChrome(rest, deps) {
  const rows = deps.listChromeProfiles();
  if (hasFlag(rest, "--porcelain")) {
    return ok(
      rows.map((p) => [p.profile, p.name, p.email, String(!!p.hasLogin)].join("\t") + "\n").join(""),
    );
  }
  if (!rows.length) return ok("(no Chrome profiles found)");
  return ok(
    rows.map((p) => `${p.profile}\t${p.name}${p.email ? " (" + p.email + ")" : ""}\t${p.hasLogin ? "✅已登录" : "—"}`).join("\n"),
  );
}

function cmdExists(rest, deps) {
  const [name] = positionals(rest);
  if (!name) return userErr("exists: name required");
  return deps.store.profileExists(name) ? ok("") : userErr(`profile not found: ${name}`);
}

function cmdPsProfile(rest) {
  const cmdline = rest.join(" ");
  const m = cmdline.match(/--profile[= ]+("([^"]*)"|'([^']*)'|(\S+))/);
  const name = m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
  return ok(name);
}

export async function run(argv, deps) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "list": return cmdList(rest, deps);
      case "chrome": return cmdChrome(rest, deps);
      case "exists": return cmdExists(rest, deps);
      case "ps-profile": return cmdPsProfile(rest);
      default: return { code: 2, stdout: "", stderr: USAGE };
    }
  } catch (e) {
    return { code: 1, stdout: "", stderr: `error: ${e.message}` };
  }
}

function makeRealDeps() {
  return {
    store,
    importer: { parseImportFile },
    listChromeProfiles,
    getChromeTikTokCookies,
    isTTY: !!process.stdin.isTTY,
    prompt: async () => "",
    readFile: (p) => fs.readFileSync(p, "utf8"),
    statFile: (p) => fs.statSync(p),
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run(process.argv.slice(2), makeRealDeps()).then(({ code, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : stdout + "\n");
    if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : stderr + "\n");
    process.exit(code);
  });
}
