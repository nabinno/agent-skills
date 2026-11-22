#!/usr/bin/env python3
"""Install one marketplace plugin on every local agent CLI.

Claude Code, Codex, and Grok Build get the marketplace, then plugin@marketplace.
Antigravity (agy) has no marketplace install. It imports Claude's plugins, and
this script uninstalls anything that import added besides the requested plugin.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


HOSTS = ("claude", "codex", "grok", "agy")
LIST_TIMEOUT = 60
MUTATE_TIMEOUT = 300


@dataclass
class HostState:
    binary: str | None = None
    marketplaces: dict[str, str] = field(default_factory=dict)
    installed_version: str | None = None
    skills_dirs: list[Path] = field(default_factory=list)


@dataclass
class State:
    home: Path
    hosts: dict[str, HostState]


def slug_from_source(source: str) -> str | None:
    text = source.strip()
    text = re.sub(r"^git@github\.com:", "github.com/", text)
    text = re.sub(r"^ssh://git@github\.com/", "github.com/", text)
    text = re.sub(r"^https?://", "", text)
    text = text.removesuffix(".git").strip("/")
    parts = [part for part in text.split("/") if part]
    if len(parts) >= 3 and parts[0].endswith("github.com"):
        return f"{parts[1]}/{parts[2]}"
    if len(parts) == 2:
        return f"{parts[0]}/{parts[1]}"
    return None


def marketplace_name_for(host: HostState, slug: str) -> str | None:
    matches = [name for name, source in host.marketplaces.items() if slug_from_source(source) == slug]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise SystemExit(f"more than one marketplace matches {slug}: {matches}")
    return None


def parse_claude_plugins(text: str) -> dict[str, str]:
    current = None
    found: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip().lstrip("❯").strip()
        if re.fullmatch(r"[A-Za-z0-9._-]+@[A-Za-z0-9._-]+", line):
            current = line
            found.setdefault(current, "")
            continue
        if current and line.lower().startswith("version:"):
            found[current] = line.split(":", 1)[1].strip()
    return found


def parse_agy_plugins(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for raw in text.splitlines():
        match = re.match(
            r"-\s+(\S+)\s+\((enabled|disabled)(?:,\s*([^)]+))?\)",
            raw.strip(),
        )
        if match:
            found[match.group(1)] = (match.group(3) or "").strip()
    return found


def version_from_cache(cache_dir: Path) -> tuple[str | None, Path | None]:
    if not cache_dir.is_dir():
        return None, None
    versions = [path for path in cache_dir.iterdir() if path.is_dir()]
    if not versions:
        return None, None
    in_use = [path for path in versions if (path / ".in_use").exists()]
    chosen = in_use[0] if len(in_use) == 1 else sorted(versions, key=lambda path: path.name)[-1]
    return chosen.name, chosen


def load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def load_toml(path: Path) -> dict:
    if not path.is_file():
        return {}
    return tomllib.loads(path.read_text(encoding="utf-8"))


def discover(home: Path) -> State:
    state = State(home=home, hosts={name: HostState(binary=shutil.which(name)) for name in HOSTS})

    known = load_json(home / ".claude/plugins/known_marketplaces.json")
    claude = state.hosts["claude"]
    for name, entry in known.items():
        source = entry.get("source") if isinstance(entry, dict) else None
        repo = source.get("repo") if isinstance(source, dict) else None
        if isinstance(repo, str):
            claude.marketplaces[name] = repo

    codex_toml = load_toml(home / ".codex/config.toml")
    codex = state.hosts["codex"]
    for name, entry in (codex_toml.get("marketplaces") or {}).items():
        if isinstance(entry, dict) and isinstance(entry.get("source"), str):
            codex.marketplaces[name] = entry["source"]

    grok_toml = load_toml(home / ".grok/config.toml")
    grok = state.hosts["grok"]
    for entry in grok_toml.get("marketplace", {}).get("sources", []) or []:
        if isinstance(entry, dict) and entry.get("name") and entry.get("git"):
            grok.marketplaces[str(entry["name"])] = str(entry["git"])

    return state


def cache_install(home: Path, host: str, marketplace: str, plugin: str) -> tuple[str | None, Path | None]:
    root = {
        "claude": home / ".claude/plugins/cache",
        "codex": home / ".codex/plugins/cache",
    }.get(host)
    if root is None:
        return None, None
    return version_from_cache(root / marketplace / plugin)


def claude_enabled(home: Path, selector: str) -> bool:
    settings = load_json(home / ".claude/settings.json")
    enabled = settings.get("enabledPlugins") or {}
    return enabled.get(selector) is True


def codex_enabled(home: Path, selector: str) -> bool:
    config = load_toml(home / ".codex/config.toml")
    plugins = config.get("plugins") or {}
    entry = plugins.get(selector)
    return isinstance(entry, dict) and entry.get("enabled") is True


def run_command(argv: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        check=False,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def read_grok_install(plugin: str) -> tuple[str | None, str | None, list[Path]]:
    binary = shutil.which("grok")
    if not binary:
        return None, None, []
    completed = run_command([binary, "plugin", "list", "--json"], LIST_TIMEOUT)
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or "grok plugin list failed")
    payload = json.loads(completed.stdout)
    if not isinstance(payload, list):
        raise SystemExit("grok plugin list --json did not return a list")
    skills_dirs: list[Path] = []
    found = None
    for entry in payload:
        if not isinstance(entry, dict) or entry.get("name") != plugin:
            continue
        if entry.get("status") not in (None, "installed"):
            continue
        found = entry
        for key in ("source", "path", "install_path"):
            raw = entry.get(key)
            if isinstance(raw, str):
                skills = Path(raw) / "skills"
                if skills.is_dir():
                    skills_dirs.append(skills)
    if found is None:
        return None, None, skills_dirs
    version = found.get("version")
    marketplace = found.get("marketplace")
    return (
        str(marketplace) if marketplace else None,
        str(version) if version else None,
        skills_dirs,
    )


def read_agy_plugins() -> dict[str, str]:
    binary = shutil.which("agy")
    if not binary:
        return {}
    completed = run_command([binary, "plugin", "list"], LIST_TIMEOUT)
    if completed.returncode != 0:
        raise SystemExit(completed.stderr.strip() or "agy plugin list failed")
    return parse_agy_plugins(completed.stdout)


def skill_names(skills_dirs: list[Path]) -> list[str]:
    names: set[str] = set()
    for skills_dir in skills_dirs:
        if not skills_dir.is_dir():
            continue
        for child in skills_dir.iterdir():
            if (child / "SKILL.md").is_file():
                names.add(child.name)
    return sorted(names)


def shadow_dirs(home: Path, names: list[str]) -> list[Path]:
    roots = [
        home / ".grok/skills",
        home / ".claude/skills",
        home / ".codex/skills",
        home / ".agents/skills",
        home / ".gemini/config/skills",
    ]
    found: list[Path] = []
    for root in roots:
        for name in names:
            path = root / name
            if path.is_symlink() or not path.is_dir():
                continue
            found.append(path)
    return found


def remove_lock_entries(home: Path, names: list[str]) -> list[str]:
    path = home / ".agents/.skill-lock.json"
    if not path.is_file() or not names:
        return []
    data = load_json(path)
    skills = data.get("skills")
    if not isinstance(skills, dict):
        return []
    dropped = [name for name in names if name in skills]
    if not dropped:
        return []
    for name in dropped:
        del skills[name]
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return dropped


def set_claude_autoupdate(home: Path, marketplace: str) -> bool:
    path = home / ".claude/settings.json"
    data = load_json(path)
    marketplaces = data.setdefault("extraKnownMarketplaces", {})
    if not isinstance(marketplaces, dict):
        raise SystemExit(f"{path} extraKnownMarketplaces is not an object")
    entry = marketplaces.setdefault(marketplace, {})
    if not isinstance(entry, dict):
        raise SystemExit(f"{path} marketplace {marketplace} is not an object")
    if entry.get("autoUpdate") is True:
        return False
    entry["autoUpdate"] = True
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return True


def command_failed(completed: subprocess.CompletedProcess[str], argv: list[str]) -> dict:
    return {
        "ok": False,
        "command": argv,
        "exit_code": completed.returncode,
        "stderr": completed.stderr.strip(),
        "stdout": completed.stdout.strip(),
    }


def ensure_marketplace(host: str, binary: str, slug: str, ref: str, state: State) -> str:
    existing = marketplace_name_for(state.hosts[host], slug)
    if existing:
        return existing
    source = slug
    if host == "claude":
        argv = [binary, "plugin", "marketplace", "add", source, "--scope", "user"]
    elif host == "codex":
        argv = [binary, "plugin", "marketplace", "add", source, "--ref", ref]
    elif host == "grok":
        argv = [binary, "plugin", "marketplace", "add", source]
    else:
        raise SystemExit(f"{host} does not add marketplaces")
    completed = run_command(argv, MUTATE_TIMEOUT)
    if completed.returncode != 0:
        raise SystemExit(json.dumps(command_failed(completed, argv)))
    refreshed = discover(state.home)
    state.hosts[host].marketplaces = refreshed.hosts[host].marketplaces
    name = marketplace_name_for(state.hosts[host], slug)
    if not name:
        raise SystemExit(f"{host} added {slug} but the marketplace name was not in its config")
    return name


def install_plugin(host: str, binary: str, selector: str, refresh: bool) -> subprocess.CompletedProcess[str] | None:
    if host == "claude":
        argv = [binary, "plugin", "update" if refresh else "install", selector, "--scope", "user"]
    elif host == "codex":
        if refresh:
            marketplace = selector.split("@", 1)[1]
            upgrade = run_command(
                [binary, "plugin", "marketplace", "upgrade", marketplace],
                MUTATE_TIMEOUT,
            )
            if upgrade.returncode != 0:
                return upgrade
        argv = [binary, "plugin", "add", selector, "--json"]
    elif host == "grok":
        argv = [binary, "plugin", "update", selector.split("@", 1)[0]] if refresh else [
            binary, "plugin", "install", selector, "--trust"
        ]
    else:
        raise SystemExit(f"{host} does not install marketplace plugins")
    return run_command(argv, MUTATE_TIMEOUT)


def update_command(host: str, selector: str) -> str:
    plugin, marketplace = selector.split("@", 1)
    if host == "claude":
        return f"claude plugin update {selector} --scope user"
    if host == "codex":
        return f"codex plugin marketplace upgrade {marketplace} && codex plugin add {selector}"
    if host == "grok":
        return f"grok plugin update {plugin}"
    return "agy plugin import claude"


def import_agy(binary: str, plugin: str, home: Path) -> dict:
    before = set(read_agy_plugins())
    completed = run_command([binary, "plugin", "import", "claude"], MUTATE_TIMEOUT)
    if completed.returncode != 0:
        return command_failed(completed, [binary, "plugin", "import", "claude"])
    after = read_agy_plugins()
    if plugin not in after:
        return {
            "ok": False,
            "command": [binary, "plugin", "import", "claude"],
            "stderr": f"import finished but {plugin} is not in agy plugin list",
            "stdout": completed.stdout.strip(),
        }
    removed = []
    for name in sorted(set(after) - before - {plugin}):
        uninstall = run_command([binary, "plugin", "uninstall", name], MUTATE_TIMEOUT)
        if uninstall.returncode != 0:
            return command_failed(uninstall, [binary, "plugin", "uninstall", name])
        removed.append(name)
    skills = home / ".gemini/config/plugins" / plugin / "skills"
    return {
        "ok": True,
        "version": after.get(plugin) or None,
        "skills_dir": str(skills) if skills.is_dir() else None,
        "removed_extra_plugins": removed,
        "update": "agy plugin import claude",
        "note": "agy stores a copy. Import again after Claude updates.",
    }


def apply_shadows(home: Path, names: list[str], remove: bool) -> dict:
    paths = shadow_dirs(home, names)
    if not remove:
        return {"paths": [str(path) for path in paths], "removed": [], "lock_dropped": []}
    removed = []
    for path in paths:
        shutil.rmtree(path)
        removed.append(str(path))
    return {
        "paths": [str(path) for path in paths],
        "removed": removed,
        "lock_dropped": remove_lock_entries(home, names),
    }


def record_cache(home: Path, host: str, marketplace: str, plugin: str, info: dict) -> None:
    version, cache = cache_install(home, host, marketplace, plugin)
    if version:
        info["version"] = version
    if cache and (cache / "skills").is_dir():
        info["skills_dir"] = str(cache / "skills")


def install_hosts(args: argparse.Namespace, state: State) -> dict:
    slug = slug_from_source(args.marketplace)
    if not slug:
        raise SystemExit(f"not a GitHub owner/repo or git URL: {args.marketplace}")
    report: dict[str, dict] = {}
    installed: dict[str, dict] = {}

    for host in ("claude", "codex", "grok"):
        host_state = state.hosts[host]
        if host_state.binary is None:
            report[host] = {"ok": True, "skipped": "not on PATH"}
            continue
        try:
            existing = marketplace_name_for(host_state, slug)
        except SystemExit as exc:
            report[host] = {"ok": False, "error": str(exc)}
            continue
        if existing is None and args.dry_run:
            report[host] = {
                "ok": True,
                "action": "would-add-marketplace-and-install",
                "marketplace_source": slug,
                "update": None,
            }
            continue
        try:
            marketplace = ensure_marketplace(host, host_state.binary, slug, args.ref, state)
        except SystemExit as exc:
            report[host] = {"ok": False, "error": str(exc)}
            continue
        selector = f"{args.plugin}@{marketplace}"
        already = False
        info: dict = {
            "ok": True,
            "marketplace": marketplace,
            "selector": selector,
            "update": update_command(host, selector),
        }
        if host == "claude" and claude_enabled(state.home, selector):
            already = True
            record_cache(state.home, host, marketplace, args.plugin, info)
        elif host == "codex" and codex_enabled(state.home, selector):
            already = True
            record_cache(state.home, host, marketplace, args.plugin, info)
        elif host == "grok":
            grok_marketplace, version, skills_dirs = read_grok_install(args.plugin)
            if grok_marketplace == marketplace:
                already = True
                info["version"] = version
                if skills_dirs:
                    info["skills_dir"] = str(skills_dirs[0])
                    info["skills_dirs"] = [str(path) for path in skills_dirs]
        if already and not args.refresh:
            info["action"] = "already-installed"
            report[host] = info
            installed[host] = info
            continue
        if args.dry_run:
            info["action"] = "would-refresh" if already else "would-install"
            report[host] = info
            continue
        completed = install_plugin(host, host_state.binary, selector, refresh=already and args.refresh)
        if completed is None or completed.returncode != 0:
            failed = command_failed(completed, completed.args if completed else [])
            failed["marketplace"] = marketplace
            report[host] = failed
            continue
        info["action"] = "refreshed" if already else "installed"
        record_cache(state.home, host, marketplace, args.plugin, info)
        if host == "grok":
            grok_marketplace, version, skills_dirs = read_grok_install(args.plugin)
            info["version"] = version
            info["marketplace_confirmed"] = grok_marketplace
            if skills_dirs:
                info["skills_dir"] = str(skills_dirs[0])
        if host == "claude" and not args.no_autoupdate and not args.dry_run:
            info["autoupdate_set"] = set_claude_autoupdate(state.home, marketplace)
        report[host] = info
        installed[host] = info

    if not args.dry_run and not args.no_autoupdate and report.get("claude", {}).get("ok") and report["claude"].get("marketplace"):
        if "autoupdate_set" not in report["claude"]:
            report["claude"]["autoupdate_set"] = set_claude_autoupdate(
                state.home, report["claude"]["marketplace"]
            )

    agy = state.hosts["agy"]
    claude_report = report.get("claude", {})
    if agy.binary is None:
        report["agy"] = {"ok": True, "skipped": "not on PATH"}
    elif not claude_report.get("ok") or claude_report.get("skipped"):
        report["agy"] = {
            "ok": True,
            "skipped": "agy only receives this plugin by importing Claude",
        }
    else:
        current = read_agy_plugins()
        if args.plugin in current and not args.refresh:
            skills = state.home / ".gemini/config/plugins" / args.plugin / "skills"
            report["agy"] = {
                "ok": True,
                "action": "already-installed",
                "version": current[args.plugin] or None,
                "skills_dir": str(skills) if skills.is_dir() else None,
                "update": "agy plugin import claude",
                "note": "agy stores a copy. Import again after Claude updates.",
            }
            installed["agy"] = report["agy"]
        elif args.dry_run:
            report["agy"] = {
                "ok": True,
                "action": "would-import-from-claude",
                "update": "agy plugin import claude",
            }
        else:
            report["agy"] = import_agy(agy.binary, args.plugin, state.home)
            if report["agy"].get("ok"):
                installed["agy"] = report["agy"]

    names: set[str] = set()
    for info in installed.values():
        raw_dirs = info.get("skills_dirs") or ([info["skills_dir"]] if info.get("skills_dir") else [])
        names.update(skill_names([Path(raw) for raw in raw_dirs]))
    if names:
        report["shadows"] = apply_shadows(state.home, sorted(names), remove=args.remove_shadows and not args.dry_run)
        report["plugin_skills"] = sorted(names)
    else:
        report["shadows"] = {"paths": [], "removed": [], "lock_dropped": []}
        report["plugin_skills"] = []
    report["ok"] = all(entry.get("ok") for entry in report.values() if isinstance(entry, dict) and "ok" in entry)
    return report


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install one official plugin on every local agent CLI.")
    parser.add_argument("--marketplace", required=True, help="GitHub owner/repo or git URL of the publisher marketplace")
    parser.add_argument("--plugin", required=True, help="Plugin name inside that marketplace")
    parser.add_argument("--ref", default="main", help="Git ref for Codex marketplace add")
    parser.add_argument("--refresh", action="store_true", help="Update hosts that already have the plugin")
    parser.add_argument("--remove-shadows", action="store_true", help="Delete real skill directories that use the plugin's skill names")
    parser.add_argument("--no-autoupdate", action="store_true", help="Do not set Claude marketplace autoUpdate")
    parser.add_argument("--dry-run", action="store_true", help="Read current state and print the actions, without installing")
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("FANOUT_HOME", str(Path.home()))))
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9._-]+", args.plugin):
        parser.error("--plugin must be a single plugin name")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    report = install_hosts(args, discover(args.home))
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.TimeoutExpired as exc:
        print(json.dumps({"ok": False, "error": f"timed out: {exc.cmd}"}), file=sys.stderr)
        raise SystemExit(1)
