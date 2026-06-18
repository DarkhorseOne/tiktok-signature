import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import * as store from "./profile-store.mjs";
import { parseImportFile } from "./cookie-import.mjs";
import { listChromeProfiles, getChromeTikTokCookies } from "./chrome-cookies.mjs";
import { hasSessionCookie } from "./constants.mjs";
import { fetchTikTokIdentity } from "./account-info.mjs";

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

  // Resolve source Chrome profile: explicit --from, else auto-detect logged-in ones.
  if (from) {
    if (!deps.listChromeProfiles().some((p) => p.profile === from)) {
      return userErr(`Chrome profile not found / no Cookies: ${from}`);
    }
  } else {
    const loggedIn = deps.listChromeProfiles().filter((p) => p.hasLogin);
    if (loggedIn.length === 0) {
      return userErr("Chrome 里没有已登录 TikTok 的会话；请先在 Chrome 登录 TikTok");
    } else if (loggedIn.length === 1) {
      from = loggedIn[0].profile;
    } else if (deps.isTTY) {
      from = await pickChromeProfile(loggedIn, deps);
      if (!from) return userErr("add: cancelled");
    } else {
      return userErr("multiple logged-in Chrome profiles; pass --from <profile>");
    }
  }

  const cookies = await deps.getChromeTikTokCookies({ profile: from });
  if (!cookies || !cookies.length) {
    return userErr(`no cookies extracted from Chrome profile: ${from}`);
  }

  const id = await deps.fetchIdentity(cookies);

  if (!name) {
    if (id && id.username) name = id.username;
    else if (deps.isTTY) name = (await deps.prompt("给这个账号起个名字: ")).trim();
    if (!name) return userErr("add: name required (could not capture TikTok username)");
  }

  if (deps.store.profileExists(name) && !force) {
    return userErr(`profile already exists: ${name} (use --force or refresh)`);
  }

  let meta;
  try {
    meta = deps.store.writeProfile(name, cookies, {
      origin: "chrome",
      sourceChromeProfile: from,
      tiktokUsername: id ? id.username : null,
      tiktokScreenName: id ? id.screenName : null,
      tiktokUserId: id ? id.userId : null,
    });
  } catch (e) {
    return userErr(e.message);
  }
  const who = id ? ` (@${id.username}${id.screenName ? " / " + id.screenName : ""})` : " (TikTok 用户名未获取)";
  const warn = meta.hasSession ? "" : "\n[warn] 提取结果不含 sessionid";
  return ok(`saved profile '${name}' from Chrome '${from}'${who} (${cookies.length} cookies)${warn}`);
}

async function pickChromeProfile(rows, deps) {
  const lines = rows.map((p, i) => `${i + 1}) ${p.profile}  ${p.name || ""}${p.email ? " (" + p.email + ")" : ""}`);
  const sel = await deps.prompt(`多个已登录 TikTok 的 Chrome profile，选一个:\n${lines.join("\n")}\n序号: `);
  const idx = Number(sel) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) return null;
  return rows[idx].profile;
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
  const fresh = hasSessionCookie(cookies);
  if (!fresh && !force) {
    return userErr(`refresh got no session cookie for '${name}'; kept existing session (use --force to overwrite)`);
  }
  deps.store.writeProfile(name, cookies, { origin: "chrome", sourceChromeProfile: meta.sourceChromeProfile });
  return ok(`refreshed '${name}' from Chrome '${meta.sourceChromeProfile}' (${cookies.length} cookies)`);
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

function cmdRename(rest, deps) {
  const [oldName, newName] = positionals(rest);
  if (!oldName || !newName) return userErr("rename: <old> <new> required");
  try {
    deps.store.renameProfile(oldName, newName);
  } catch (e) {
    return userErr(e.message);
  }
  return ok(`renamed '${oldName}' -> '${newName}'`);
}

async function cmdDelete(rest, deps) {
  const name = positionals(rest)[0];
  if (!name) return userErr("delete: name required");
  if (!deps.store.profileExists(name)) return userErr(`profile not found: ${name}`);
  if (deps.isTTY && !hasFlag(rest, "--yes")) {
    const yn = (await deps.prompt(`确认删除 '${name}'? [y/N] `)).trim().toLowerCase();
    if (yn !== "y" && yn !== "yes") return ok("cancelled");
  }
  try {
    deps.store.deleteProfile(name);
  } catch (e) {
    return userErr(e.message);
  }
  return ok(`deleted '${name}'`);
}

function cmdBackup(rest, deps) {
  const [name, dest] = positionals(rest);
  if (!name) return userErr("backup: name required");
  let out;
  try {
    out = deps.store.backupProfile(name, dest);
  } catch (e) {
    return userErr(e.message);
  }
  const warn = insideGitTree(out) ? "\n[warn] 备份落在 git 工作树内，注意勿提交（含凭据）" : "";
  return ok(`backed up '${name}' -> ${out}${warn}`);
}

function insideGitTree(p) {
  let d = path.dirname(path.resolve(p));
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return false;
}

function cmdImport(rest, deps) {
  const [file, nameArg] = positionals(rest);
  const force = hasFlag(rest, "--force");
  if (!file) return userErr("import: <file> required");
  let size;
  try {
    size = deps.statFile(file).size;
  } catch (e) {
    return userErr(`cannot read import file: ${file}`);
  }
  if (size > MAX_IMPORT_BYTES) return userErr(`import file too large (> ${MAX_IMPORT_BYTES} bytes)`);
  let parsed;
  try {
    parsed = deps.importer.parseImportFile(deps.readFile(file));
  } catch (e) {
    return userErr(e.message);
  }
  const name = nameArg || (parsed.meta && parsed.meta.name);
  if (!name) return userErr("import: name required for this file (extension export has no name)");
  if (deps.store.profileExists(name) && !force) {
    return userErr(`profile already exists: ${name} (use --force)`);
  }
  const metaIn = parsed.meta
    ? { origin: parsed.meta.origin || "imported", sourceChromeProfile: parsed.meta.sourceChromeProfile ?? null }
    : { origin: "imported", sourceChromeProfile: null };
  const meta = deps.store.writeProfile(name, parsed.cookies, metaIn);
  const warn = meta.hasSession ? "" : "\n[warn] 导入内容不含 sessionid";
  return ok(`imported profile '${name}' (${parsed.cookies.length} cookies)${warn}`);
}

async function cmdPickStart(_rest, deps) {
  const rows = deps.store.listProfiles();
  if (!rows.length) {
    return { code: 2, stdout: "", stderr: "no saved profiles; run `profile add` first" };
  }
  if (!deps.isTTY) {
    return { code: 2, stdout: "", stderr: "no TTY for interactive selection; pass a profile name to start" };
  }
  const lines = rows.map((p, i) => `${i + 1}) ${p.name}  [${p.meta.origin}]  ${p.meta.hasSession ? "✅" : "❌"}  ${p.meta.refreshedAt}`);
  const sel = await deps.prompt(`选择要启动的账号:\n${lines.join("\n")}\n序号: `);
  const idx = Number(sel) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) {
    return { code: 2, stdout: "", stderr: "cancelled / invalid selection" };
  }
  return { code: 0, stdout: rows[idx].name, stderr: "" };
}

export async function run(argv, deps) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "list": return cmdList(rest, deps);
      case "chrome": return cmdChrome(rest, deps);
      case "add": return await cmdAdd(rest, deps);
      case "refresh": return await cmdRefresh(rest, deps);
      case "rename": return cmdRename(rest, deps);
      case "delete": return await cmdDelete(rest, deps);
      case "backup": return cmdBackup(rest, deps);
      case "import":
      case "restore": return cmdImport(rest, deps);
      case "pick-start": return await cmdPickStart(rest, deps);
      case "exists": return cmdExists(rest, deps);
      case "ps-profile": return cmdPsProfile(rest);
      default: return { code: 2, stdout: "", stderr: USAGE };
    }
  } catch (e) {
    return { code: 1, stdout: "", stderr: `error: ${e.message}` };
  }
}

function realPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

function makeRealDeps() {
  return {
    store,
    importer: { parseImportFile },
    listChromeProfiles,
    getChromeTikTokCookies,
    fetchIdentity: (cookies) => fetchTikTokIdentity(cookies),
    isTTY: !!process.stdin.isTTY,
    prompt: realPrompt,
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
