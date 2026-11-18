#!/usr/bin/env node
// Host layer for cb. Callers use these operations and do not branch on the OS.
//
// hostKind() is "mac", "win" (Windows PowerShell / cmd), "wsl", or "linux".
// WSL is detected before a plain Linux host, because process.platform is
// "linux" in both cases.

import { spawn, spawnSync } from "node:child_process";
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

// CreateProcess does not search PATHEXT. npm's global shim is an extensionless
// shell script plus a sibling .cmd; executing the script returns ENOENT and
// never reaches the real .exe. Prefer name.exe, then an .exe named inside an
// npm .cmd shim. A bare .cmd/.bat is started through ProcessStartInfo so "&"
// in an argument is not reparsed as another command.
function existsFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function searchPathWin(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const ext of [".exe", ".com", ".cmd", ".bat"]) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name + ext);
      if (existsFile(candidate)) return candidate;
    }
  }
  return null;
}

function exeFromCmdShim(cmdPath) {
  let text;
  try {
    text = fs.readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/"%~dp0([^"]+\.exe)"/i);
  if (!match) return null;
  const exe = path.join(path.dirname(cmdPath), match[1]);
  return existsFile(exe) ? exe : null;
}

function quoteWinArg(arg) {
  const s = String(arg);
  if (s === "" || /[\s"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function spawnSpec(cmd, args) {
  const plain = { file: cmd, args };
  if (process.platform !== "win32" || path.isAbsolute(cmd) || /[\\/]/.test(cmd)) return plain;
  const ext = path.extname(cmd).toLowerCase();
  if (ext === ".exe" || ext === ".com" || ext === ".cmd" || ext === ".bat") return plain;
  const found = searchPathWin(cmd);
  if (!found) return plain;
  const foundExt = path.extname(found).toLowerCase();
  if (foundExt === ".exe" || foundExt === ".com") return { file: found, args };
  const exe = exeFromCmdShim(found);
  if (exe) return { file: exe, args };
  // The call operator reparses "&" when the target is a batch file.
  // ProcessStartInfo quotes each argument, which cmd.exe then keeps intact.
  const ps = [
    "$psi = New-Object System.Diagnostics.ProcessStartInfo",
    "$psi.FileName = $env:CB_CMD_FILE",
    "$psi.UseShellExecute = $false",
    "$psi.CreateNoWindow = $true",
    "$psi.RedirectStandardOutput = $true",
    "$psi.RedirectStandardError = $true",
    "$sb = New-Object System.Text.StringBuilder",
    "for ($i = 0; $i -lt [int]$env:CB_CMD_COUNT; $i++) {",
    "  if ($i -gt 0) { [void]$sb.Append(' ') }",
    "  $val = (Get-Item -Path env:\\CB_CMD_ARG_$i).Value",
    "  if ($null -eq $val) { $val = '' }",
    "  [void]$sb.Append([char]34).Append($val.Replace(([char]34).ToString(), ([char]34).ToString() + ([char]34).ToString())).Append([char]34)",
    "}",
    "$psi.Arguments = $sb.ToString()",
    "$proc = [Diagnostics.Process]::Start($psi)",
    "$stdout = $proc.StandardOutput.ReadToEnd()",
    "$stderr = $proc.StandardError.ReadToEnd()",
    "$proc.WaitForExit()",
    "[Console]::Out.Write($stdout)",
    "[Console]::Error.Write($stderr)",
    "exit $proc.ExitCode",
  ].join("; ");
  const env = { CB_CMD_FILE: found, CB_CMD_COUNT: String(args.length) };
  args.forEach((arg, i) => {
    env[`CB_CMD_ARG_${i}`] = String(arg);
  });
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", ps],
    env,
  };
}

function launchSync(cmd, args, { timeout = 25, input, stdio } = {}) {
  const spec = spawnSpec(cmd, args);
  return spawnSync(spec.file, spec.args, {
    encoding: "utf8",
    input,
    timeout: timeout * 1000,
    stdio: stdio ?? "pipe",
    windowsHide: true,
    env: spec.env ? { ...process.env, ...spec.env } : undefined,
  });
}

function spawnText(cmd, args, timeoutSec) {
  const r = launchSync(cmd, args, { timeout: timeoutSec });
  return {
    code: r.status ?? (r.error ? 1 : 0),
    out: (r.stdout ?? "").replace(/\r/g, "").trim(),
    err: [r.stderr, r.error?.message].filter(Boolean).join("\n").trim(),
  };
}

function decodeOutput(buf) {
  if (!buf || buf.length === 0) return "";
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  let zeros = 0;
  const n = Math.min(buf.length, 32);
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++;
  if (zeros > 4) return buf.toString("utf16le");
  return buf.toString("utf8");
}

// A detached child of this process stays in the caller's Windows job. The job
// kills it when the command ends, so the next cb opens a new Chrome connection
// and the permission dialog appears again. Win32_Process.Create runs from
// WmiPrvSE, outside that job, and the hub keeps the one approved connection.
function spawnDetachedWindows(execPath, args) {
  const commandLine = [execPath, ...args].map(quoteWinArg).join(" ");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:CB_DETACH_CMDLINE }",
    "if ([int]$r.ReturnValue -ne 0) { Write-Output ('ERR ' + $r.ReturnValue); exit 1 }",
    "Write-Output $r.ProcessId",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    windowsHide: true,
    env: { ...process.env, CB_DETACH_CMDLINE: commandLine },
  });
  const out = decodeOutput(r.stdout).trim();
  const err = decodeOutput(r.stderr).trim();
  const pid = Number((out.match(/\d+/) || [])[0]);
  if (r.status !== 0 || !pid) throw new Error(err || out || "Win32_Process.Create failed");
  return { pid };
}

// Start a process that outlives this command. logFile is opened by the child.
export function spawnDetached(execPath, args) {
  if (process.platform === "win32") return spawnDetachedWindows(execPath, args);
  const child = spawn(execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { pid: child.pid };
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
  const r = launchSync(cmd, args, { timeout, input, stdio });
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
