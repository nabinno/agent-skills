#!/usr/bin/env node
// Host layer for cb. Callers use these operations and do not branch on the OS.
//
// hostKind() is "mac", "win" (Windows PowerShell / cmd), "wsl", or "linux".
// WSL is detected before a plain Linux host, because process.platform is
// "linux" in both cases.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function hostKind() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  if (isWsl()) return "wsl";
  return "linux";
}

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

const cacheDir = () => path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "cb");

function spawnText(cmd, args, timeoutSec) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutSec * 1000, windowsHide: true });
  return {
    code: r.status ?? (r.error ? 1 : 0),
    out: (r.stdout ?? "").replace(/\r/g, "").trim(),
    err: [r.stderr, r.error?.message].filter(Boolean).join("\n").trim(),
  };
}

let wslLocal;
function wslLocalAppDataUnix() {
  if (wslLocal) return wslLocal;
  const cache = path.join(cacheDir(), "userdata.json");
  try {
    const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
    const hit = saved.localAppDataUnix || saved.local;
    if (hit) return (wslLocal = hit);
  } catch {}
  const win = spawnText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Write-Output $env:LOCALAPPDATA"], 15);
  if (!win.out) throw new Error(`could not read Windows LOCALAPPDATA${win.err ? `: ${win.err}` : ""}`);
  const unix = spawnText("wslpath", ["-u", win.out], 5);
  if (unix.code !== 0 || !unix.out) throw new Error(unix.err || "wslpath -u failed");
  wslLocal = unix.out;
  fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cache, JSON.stringify({ localAppDataUnix: wslLocal, local: wslLocal }));
  return wslLocal;
}

function wslToUnix(windowsPath) {
  const r = spawnText("wslpath", ["-u", windowsPath], 5);
  if (r.code !== 0 || !r.out) throw new Error(r.err || "wslpath -u failed");
  return r.out;
}

// Chrome's user-data directory. CDP_CHROME_USER_DATA_DIR wins on every host.
export function chromeUserDataDir() {
  if (process.env.CDP_CHROME_USER_DATA_DIR) return process.env.CDP_CHROME_USER_DATA_DIR;
  const kind = hostKind();
  if (kind === "mac") return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  if (kind === "win") {
    const base = process.env.LOCALAPPDATA;
    if (!base) throw new Error("LOCALAPPDATA is unset");
    return path.join(base, "Google", "Chrome", "User Data");
  }
  if (kind === "wsl") return wslChromeUserDataDir();
  return path.join(os.homedir(), ".config", "google-chrome");
}

// Prefer USER_PROFILE when it already points at a mounted Windows profile
// (this environment sets it to /mnt/c/Users/<name>). Otherwise ask Windows.
function wslChromeUserDataDir() {
  const profile = process.env.USER_PROFILE;
  if (profile) {
    const root = /^[A-Za-z]:[\\/]/.test(profile) || profile.startsWith("\\\\") ? wslToUnix(profile) : profile;
    const candidate = path.join(root, "AppData", "Local", "Google", "Chrome", "User Data");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(wslLocalAppDataUnix(), "Google", "Chrome", "User Data");
}

// Where install-bridge copies the extension. Independent of CDP_CHROME_USER_DATA_DIR.
export function bridgeDir() {
  const kind = hostKind();
  if (kind === "mac") return path.join(os.homedir(), "Library", "Application Support", "agent-skills", "cb-bridge");
  if (kind === "win") {
    const base = process.env.LOCALAPPDATA;
    if (!base) throw new Error("LOCALAPPDATA is unset");
    return path.join(base, "agent-skills", "cb-bridge");
  }
  if (kind === "wsl") return path.join(wslLocalAppDataUnix(), "agent-skills", "cb-bridge");
  return path.join(os.homedir(), ".local", "share", "agent-skills", "cb-bridge");
}

// Path the user pastes into Chrome's "Load unpacked" dialog.
export function displayPath(p) {
  if (hostKind() !== "wsl") return p;
  const r = spawnText("wslpath", ["-w", p], 5);
  if (r.code !== 0 || !r.out) throw new Error(r.err || "wslpath -w failed");
  return r.out;
}

// Linux keeps the /proc check so a zombie from a detached child counts as dead.
// macOS and Windows have no /proc; process.kill(pid, 0) is the existence test.
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (process.platform === "linux") {
    try {
      return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${n}/stat`, "utf8"));
    } catch {
      return false;
    }
  }
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

// timeout is seconds. Uses Node's own timer so GNU timeout is not required.
export function run(cmd, args, { timeout = 25, input, stdio } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input,
    timeout: timeout * 1000,
    stdio: stdio ?? "pipe",
    windowsHide: true,
  });
  return {
    code: r.status ?? (r.error ? 1 : 0),
    out: r.stdout ?? "",
    err: [r.stderr, r.error?.message].filter(Boolean).join(""),
    signal: r.signal ?? null,
  };
}

function normalizeWs(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("CDP_URLにはブラウザ固有のws://またはwss://接続先を指定してください。");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("CDP_URLにはブラウザ固有のws://またはwss://接続先を指定してください。");
  }
  return url;
}

// WebSocket URL from DevToolsActivePort. Does not connect.
export function chromeWebSocketUrl() {
  if (process.env.CDP_URL) return normalizeWs(process.env.CDP_URL);
  const active = path.join(chromeUserDataDir(), "DevToolsActivePort");
  let text;
  try {
    text = fs.readFileSync(active, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "普段のChromeで chrome://inspect/#remote-debugging を開き、リモートデバッグを有効にしてください。Chrome 144以降が必要です。",
      );
    }
    throw error;
  }
  const lines = text.split(/\r?\n/);
  const port = Number(lines[0]);
  if (
    !Number.isInteger(port) ||
    !(port > 0 && port < 65536) ||
    !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1] ?? "")
  ) {
    throw new Error(`Chromeの接続情報が不正です: ${active}`);
  }
  let host = process.env.CDP_HOST || "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return normalizeWs(`ws://${host}:${port}${lines[1]}`);
}

export function checkTcp(url, timeoutMs = 3000) {
  const parsed = new URL(url);
  const port = Number(parsed.port || (parsed.protocol === "wss:" ? 443 : 80));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: parsed.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function doctor() {
  const failures = [];
  const kind = hostKind();
  let chrome = "";
  try {
    chrome = chromeUserDataDir();
    if (!path.isAbsolute(chrome)) failures.push("chromeUserDataDir is not absolute");
    if (!fs.existsSync(chrome)) failures.push(`chrome user-data directory is missing: ${chrome}`);
  } catch (error) {
    failures.push(`chromeUserDataDir: ${error.message}`);
  }
  if (!pidAlive(process.pid)) failures.push("pidAlive(self) is false");
  const pong = run(process.execPath, ["-e", "process.stdout.write('pong')"], { timeout: 10 });
  if (pong.code !== 0 || !pong.out.includes("pong")) failures.push(`run echo failed: ${pong.code} ${pong.err}`);
  const hung = run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 1 });
  if (hung.code === 0) failures.push("run timeout did not fire");
  let bridge = "";
  try {
    bridge = bridgeDir();
    if (!path.isAbsolute(bridge)) failures.push("bridgeDir is not absolute");
    const shown = displayPath(bridge);
    if (!shown) failures.push("displayPath returned empty");
  } catch (error) {
    failures.push(`bridgeDir: ${error.message}`);
  }
  let devtools = null;
  try {
    devtools = chromeWebSocketUrl();
  } catch {
    devtools = null;
  }
  return { kind, chrome, bridge, devtools, failures };
}

const selfPath = path.resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMain = selfPath === invokedPath || (process.platform === "win32" && selfPath.toLowerCase() === invokedPath.toLowerCase());
if (isMain) {
  const report = await doctor();
  console.log(JSON.stringify(report));
  if (report.failures.length) {
    for (const failure of report.failures) console.error(`platform: ${failure}`);
    process.exit(1);
  }
}
