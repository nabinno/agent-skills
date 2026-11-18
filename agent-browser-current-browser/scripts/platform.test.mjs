import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, chromeWebSocketUrl, pidAlive } from "./platform.mjs";

test("native execution preserves arguments, input, exit codes and timeout", () => {
  const args = ["日本語", "", 'a"b', "a&b", "%PATH%", "!test!", "C:\\space path\\"];
  const r = run(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), args);
  assert.equal(run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "日本語" }).out, "日本語");
  assert.equal(run(process.execPath, ["-e", "process.exit(7)"]).code, 7);
  assert.notEqual(run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 0.1 }).code, 0);
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-1), false);
});

test("Windows npm shims bypass batch expansion", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-platform-"));
  const oldPath = process.env.PATH;
  const oldUrl = process.env.CDP_URL;
  try {
    fs.writeFileSync(path.join(dir, "echo.cjs"), "console.log(JSON.stringify(process.argv.slice(2))); process.stdin.pipe(process.stdout);");
    fs.writeFileSync(path.join(dir, "agent-browser.cmd"), '@echo off\r\n"%_prog%" "%dp0%\\echo.cjs" %*\r\n');
    fs.writeFileSync(path.join(dir, "legacy.cmd"), '@echo off\r\necho %*\r\n');
    process.env.PATH = dir + path.delimiter + oldPath;
    const args = ["日本語", "", 'a"b', "a&b", "%PATH%", "!test!", "C:\\space path\\"];
    for (const cmd of ["agent-browser", "agent-browser.cmd", path.join(dir, "agent-browser.cmd")]) {
      const r = run(cmd, args);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.err, "");
      assert.deepEqual(JSON.parse(r.out), args);
    }
    assert.throws(() => run("legacy", args), /Cannot safely execute batch file/);
    process.env.CDP_URL = "ws://127.0.0.1:12345/devtools/browser/fixture";
    const cdp = fileURLToPath(new URL("./cdp", import.meta.url));
    const r = spawnSync(process.execPath, [cdp], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ["connect", process.env.CDP_URL]);
    fs.writeFileSync(path.join(dir, "agent-browser.cmd"), '@echo off\r\n"%~dp0echo.cjs.exe" %*\r\n');
    fs.copyFileSync(process.execPath, path.join(dir, "echo.cjs.exe"));
    assert.equal(run("agent-browser", ["--version"]).out.trim(), process.version);
  } finally {
    process.env.PATH = oldPath;
    if (oldUrl === undefined) delete process.env.CDP_URL; else process.env.CDP_URL = oldUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DevToolsActivePort validates port and browser path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-devtools-"));
  const saved = { CDP_URL: process.env.CDP_URL, CDP_HOST: process.env.CDP_HOST, CDP_CHROME_USER_DATA_DIR: process.env.CDP_CHROME_USER_DATA_DIR };
  try {
    delete process.env.CDP_URL;
    delete process.env.CDP_HOST;
    process.env.CDP_CHROME_USER_DATA_DIR = dir;
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "12345\r\n/devtools/browser/abc-123\r\n");
    assert.equal(chromeWebSocketUrl(), "ws://127.0.0.1:12345/devtools/browser/abc-123");
    for (const text of ["70000\n/devtools/browser/a", "12345\n/json"]) {
      fs.writeFileSync(path.join(dir, "DevToolsActivePort"), text);
      assert.throws(chromeWebSocketUrl);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
