import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { hasSessionCookie } from "./constants.mjs";

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function baseDir() {
  return (
    process.env.TIKTOK_SIG_AUTH_HOME ||
    path.join(os.homedir(), ".tiktok-sig-auth")
  );
}
export function profilesDir() {
  return path.join(baseDir(), "profiles");
}
export function backupsDir() {
  return path.join(baseDir(), "backups");
}
export function profileDir(name) {
  return path.join(profilesDir(), name);
}

export function assertValidName(name) {
  if (typeof name !== "string" || name === "." || name === ".." || !NAME_RE.test(name)) {
    throw new Error(`invalid profile name: ${JSON.stringify(name)}`);
  }
  return name;
}

function assertContained(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c !== p && !c.startsWith(p + path.sep)) {
    throw new Error(`path escapes ${parent}: ${child}`);
  }
}

function assertSafeBase() {
  const b = baseDir();
  if (!path.isAbsolute(b)) {
    throw new Error(`TIKTOK_SIG_AUTH_HOME must be absolute: ${b}`);
  }
  let st;
  try {
    st = fs.lstatSync(b);
  } catch (e) {
    return; // 尚不存在 -> 将被创建
  }
  if (st.isSymbolicLink()) throw new Error(`base dir is a symlink: ${b}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`base dir not owned by current user: ${b}`);
  }
}

/** 创建目录并强制 0700（mode 受 umask 影响，需补 chmod） */
export function secureMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** 原子安全写：同目录临时文件(O_EXCL|O_NOFOLLOW,0600)+fsync+rename，无可读窗口 */
export function secureWriteFile(filePath, data, { noClobber = false } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch (e2) {}
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  try { fs.closeSync(fd); } catch (e) {}
  try {
    if (noClobber) {
      fs.linkSync(tmp, filePath); // atomic; throws EEXIST if dest already exists
      fs.rmSync(tmp, { force: true });
    } else {
      fs.renameSync(tmp, filePath);
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.chmodSync(filePath, 0o600);
}

function ensureDirs(...dirs) {
  assertSafeBase();
  secureMkdir(baseDir());
  for (const d of dirs) secureMkdir(d);
}

export function writeProfile(name, cookies, metaIn = {}) {
  assertValidName(name);
  const dir = profileDir(name);
  assertContained(profilesDir(), dir);
  ensureDirs(profilesDir(), dir);

  const metaPath = path.join(dir, "meta.json");
  let createdAt;
  try {
    createdAt = JSON.parse(fs.readFileSync(metaPath, "utf8")).createdAt;
  } catch (e) {}
  const now = new Date().toISOString();
  const meta = {
    name,
    origin: metaIn.origin === "imported" ? "imported" : "chrome",
    sourceChromeProfile: metaIn.sourceChromeProfile ?? null,
    createdAt: createdAt || now,
    refreshedAt: now,
    cookieCount: Array.isArray(cookies) ? cookies.length : 0,
    hasSession: hasSessionCookie(cookies),
  };
  secureWriteFile(path.join(dir, "cookies.json"), JSON.stringify(cookies, null, 2));
  secureWriteFile(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

export function readProfile(name) {
  assertValidName(name);
  const dir = profileDir(name);
  let meta, cookies;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    cookies = JSON.parse(fs.readFileSync(path.join(dir, "cookies.json"), "utf8"));
  } catch (e) {
    throw new Error(`profile not found: ${name}`);
  }
  return { meta, cookies };
}

export function loadProfileCookies(name) {
  return readProfile(name).cookies;
}

export function profileExists(name) {
  try {
    assertValidName(name);
  } catch (e) {
    return false;
  }
  return fs.existsSync(path.join(profileDir(name), "meta.json"));
}

export function listProfiles() {
  let entries = [];
  try {
    entries = fs
      .readdirSync(profilesDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory());
  } catch (e) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(profilesDir(), e.name, "meta.json"), "utf8"),
      );
      out.push({ name: e.name, meta });
    } catch (err) {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function deleteProfile(name) {
  assertValidName(name);
  const dir = profileDir(name);
  assertContained(profilesDir(), dir);
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    throw new Error(`profile not found: ${name}`);
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to delete symlink: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function renameProfile(oldName, newName) {
  assertValidName(oldName);
  assertValidName(newName);
  assertContained(profilesDir(), profileDir(oldName));
  if (!profileExists(oldName)) throw new Error(`profile not found: ${oldName}`);
  if (fs.existsSync(profileDir(newName))) throw new Error(`profile already exists: ${newName}`);
  const to = profileDir(newName);
  assertContained(profilesDir(), to);
  fs.renameSync(profileDir(oldName), to);
  const metaPath = path.join(to, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.name = newName;
  secureWriteFile(metaPath, JSON.stringify(meta, null, 2));
}

function backupTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("T", "-");
}

export function backupProfile(name, destPath) {
  const { meta, cookies } = readProfile(name);
  const payload = JSON.stringify(
    {
      type: "tiktok-sig-auth-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      meta,
      cookies,
    },
    null,
    2,
  );
  let dest;
  let noClobber = false;
  if (destPath) {
    dest = path.resolve(destPath);
    if (fs.existsSync(dest)) {
      throw new Error(`backup destination already exists: ${dest}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    noClobber = true;
  } else {
    ensureDirs(backupsDir());
    dest = path.join(backupsDir(), `${name}-${backupTimestamp()}.json`);
  }
  secureWriteFile(dest, payload, { noClobber });
  return dest;
}
