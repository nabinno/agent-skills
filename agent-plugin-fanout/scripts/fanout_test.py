#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fanout


class FanoutTest(unittest.TestCase):
    def test_slug_rejects_prefix_lookalikes(self):
        self.assertEqual(fanout.slug_from_source("cursor/plugins"), "cursor/plugins")
        self.assertEqual(
            fanout.slug_from_source("https://github.com/cursor/plugins.git"),
            "cursor/plugins",
        )
        self.assertEqual(
            fanout.slug_from_source("git@github.com:cursor/plugins.git"),
            "cursor/plugins",
        )
        self.assertNotEqual(
            fanout.slug_from_source("https://github.com/cursor/plugins-extra.git"),
            "cursor/plugins",
        )

    def test_marketplace_name_matches_one_source(self):
        host = fanout.HostState(
            marketplaces={
                "plugins": "https://github.com/cursor/plugins.git",
                "xAI Official": "https://github.com/xai-org/plugin-marketplace.git",
            }
        )
        self.assertEqual(fanout.marketplace_name_for(host, "cursor/plugins"), "plugins")
        self.assertIsNone(fanout.marketplace_name_for(host, "cursor/other"))

    def test_parsers(self):
        claude = """
Installed plugins:

  ❯ pstack@cursor-plugins
    Version: 0.15.46
    Scope: user
"""
        self.assertEqual(
            fanout.parse_claude_plugins(claude),
            {"pstack@cursor-plugins": "0.15.46"},
        )
        agy = """
Installed plugins:
- pstack (enabled, 0.15.46)
    Source:     claude-code
- other (disabled)
"""
        self.assertEqual(
            fanout.parse_agy_plugins(agy),
            {"pstack": "0.15.46", "other": ""},
        )

    def test_version_prefers_in_use(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "0.1.0").mkdir()
            current = root / "0.15.46"
            current.mkdir()
            (current / ".in_use").write_text("", encoding="utf-8")
            version, path = fanout.version_from_cache(root)
            self.assertEqual(version, "0.15.46")
            self.assertEqual(path, current)

    def test_shadows_keep_symlinks_and_lock_entries(self):
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            real = home / ".grok/skills/how"
            real.mkdir(parents=True)
            link_dir = home / ".claude/skills"
            link_dir.mkdir(parents=True)
            target = home / "elsewhere/how"
            target.mkdir(parents=True)
            (link_dir / "how").symlink_to(target, target_is_directory=True)
            self.assertEqual(fanout.shadow_dirs(home, ["how"]), [real])

            lock = home / ".agents/.skill-lock.json"
            lock.parent.mkdir(parents=True)
            lock.write_text(
                json.dumps({"version": 1, "skills": {"how": {"source": "fork"}, "keep": {}}}),
                encoding="utf-8",
            )
            dropped = fanout.remove_lock_entries(home, ["how"])
            self.assertEqual(dropped, ["how"])
            self.assertEqual(json.loads(lock.read_text(encoding="utf-8"))["skills"], {"keep": {}})

    def test_autoupdate_writes_once(self):
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            path = home / ".claude/settings.json"
            path.parent.mkdir()
            path.write_text(
                json.dumps({"extraKnownMarketplaces": {"cursor-plugins": {"source": {}}}}),
                encoding="utf-8",
            )
            self.assertTrue(fanout.set_claude_autoupdate(home, "cursor-plugins"))
            self.assertFalse(fanout.set_claude_autoupdate(home, "cursor-plugins"))
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertTrue(saved["extraKnownMarketplaces"]["cursor-plugins"]["autoUpdate"])

    def test_update_commands(self):
        self.assertEqual(
            fanout.update_command("claude", "pstack@cursor-plugins"),
            "claude plugin update pstack@cursor-plugins --scope user",
        )
        self.assertEqual(
            fanout.update_command("grok", "pstack@plugins"),
            "grok plugin update pstack",
        )
        self.assertEqual(fanout.update_command("agy", "pstack@unused"), "agy plugin import claude")


if __name__ == "__main__":
    unittest.main()
