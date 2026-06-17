import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as store from "./profile-store.mjs";
import { parseImportFile } from "./cookie-import.mjs";
import { listChromeProfiles, getChromeTikTokCookies } from "./chrome-cookies.mjs";

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

async function cmdAdd(rest, deps) {
  let name = positionals(rest)[0];
  let from = flagVal(rest, "--from");
  const force = hasFlag(rest, "--force");
  if ((!name || !from) && deps.isTTY) {
    const picked = await interactiveAdd(deps);
    if (!picked) return userErr("add: cancelled");
    name = name || picked.name;
    from = from || picked.from;
  }
  if (!name) return userErr("add: name required");
  if (!from) return userErr("add: --from <chromeProfile> required");
  if (deps.store.profileExists(name) && !force) {
    return userErr(`profile already exists: ${name} (use --force or refresh)`);
  }
  const available = deps.listChromeProfiles();
  if (!available.some((p) => p.profile === from)) {
    return userErr(`Chrome profile not found / no Cookies: ${from}`);
  }
  const cookies = await deps.getChromeTikTokCookies({ profile: from });
  if (!cookies || !cookies.length) {
    return userErr(`no cookies extracted from Chrome profile: ${from}`);
  }
  const meta = deps.store.writeProfile(name, cookies, { origin: "chrome", sourceChromeProfile: from });
  const warn = meta.hasSession ? "" : "\n[warn] 提取结果不含 sessionid（该 Chrome profile 可能未登录）";
  return ok(`saved profile '${name}' from Chrome '${from}' (${cookies.length} cookies)${warn}`);
}

async function interactiveAdd(deps) {
  const rows = deps.listChromeProfiles();
  if (!rows.length) return null;
  const lines = rows.map((p, i) => `${i + 1}) ${p.profile}  ${p.name}${p.email ? " (" + p.email + ")" : ""}  ${p.hasLogin ? "✅" : "—"}`);
  const sel = await deps.prompt(`选择要提取的 Chrome profile:\n${lines.join("\n")}\n序号: `);
  const idx = Number(sel) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) return null;
  const name = (await deps.prompt("给这个账号起个名字: ")).trim();
  if (!name) return null;
  return { name, from: rows[idx].profile };
}

async function cmdRefresh(rest, deps) {
  const name = positionals(rest)[0];
  const force = hasFlag(rest, "--force");
  if (!name) return userErr("refresh: name required");
  let meta;
  try {
    meta = deps.store.readProfile(name).meta;
  } catch (e) {
    return userErr(`profile not found: ${name}`);
  }
  if (!meta.sourceChromeProfile) {
    return userErr(`profile '${name}' has no Chrome source to refresh from (imported)`);
  }
  const cookies = await deps.getChromeTikTokCookies({ profile: meta.sourceChromeProfile });
  if (!cookies || !cookies.length) {
    return userErr(`refresh: no cookies extracted from Chrome profile: ${meta.sourceChromeProfile} (kept existing session)`);
  }
  const fresh = cookies && cookies.some((c) => c.name === "sessionid");
  if (!fresh && !force) {
    return userErr(`refresh got no sessionid for '${name}'; kept existing session (use --force to overwrite)`);
  }
  deps.store.writeProfile(name, cookies, { origin: "chrome", sourceChromeProfile: meta.sourceChromeProfile });
  return ok(`refreshed '${name}' from Chrome '${meta.sourceChromeProfile}' (${cookies.length} cookies)`);
}

export async function run(argv, deps) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "list": return cmdList(rest, deps);
      case "chrome": return cmdChrome(rest, deps);
      case "add": return await cmdAdd(rest, deps);
      case "refresh": return await cmdRefresh(rest, deps);
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
