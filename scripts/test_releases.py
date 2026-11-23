"""Offline checks for numbered immutable releases (Bash required)."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

from release_manifest import manifest
from release_version import plan_release


ROOT = Path(__file__).resolve().parents[1]
COMMIT = "a" * 40

# Exercise the actual workflow shell with a GitHub stand-in that rejects writes
# to published releases. No network calls, tags or real releases are made.
FAKE_GH = r"""
gh() {
  printf '%s\n' "$*" >> "$FAKE_LOG"
  if [ "$1" = api ]; then
    test "$2" = "repos/$GITHUB_REPOSITORY/commits/main" || return 90
    printf '%s\n' "$LATEST_COMMIT"
    return
  fi
  test "$1" = release || return 91
  case "$2" in
    view)
      case " $* " in *" targetCommitish "*) printf '%s\n' "$RELEASE_TARGET"; return ;; esac
      case "$(cat "$FAKE_STATE")" in
        missing) return 1 ;;
        draft) echo true ;;
        published) echo false ;;
      esac ;;
    create)
      test "$(cat "$FAKE_STATE")" = missing || return 92
      case " $* " in *" --draft "*) ;; *) return 93 ;; esac
      case " $* " in *" --prerelease "*|*" preview-"*) return 100 ;; esac
      echo draft > "$FAKE_STATE" ;;
    upload)
      test "$(cat "$FAKE_STATE")" = draft || return 94
      test "$FAIL_UPLOAD" = 0 || return 95
      echo yes > "$FAKE_UPLOADED" ;;
    edit)
      test "$(cat "$FAKE_STATE")" = draft || return 96
      test -f "$FAKE_UPLOADED" || return 97
      case " $* " in *" --draft=false "*) ;; *) return 98 ;; esac
      case " $* " in *" --prerelease "*|*" --latest=false "*) return 101 ;; esac
      echo published > "$FAKE_STATE" ;;
    *) return 99 ;;
  esac
}
"""


class PublicationTests(unittest.TestCase):
    def run_publication(self, workflow, step, state, fail=False, stale=False, wrong_commit=False):
        source = (ROOT / ".github/workflows" / workflow).read_text(encoding="utf-8")
        script = textwrap.dedent(source.split("- name: " + step, 1)[1].split("run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            state_path = directory / "state"
            state_path.write_text(state)
            env = dict(os.environ, FAKE_STATE=state_path.as_posix(),
                       FAKE_LOG=(directory / "calls").as_posix(),
                       FAKE_UPLOADED=(directory / "uploaded").as_posix(),
                       GITHUB_REPOSITORY="hangry-labs/llama.nodrama", BUILD_COMMIT=COMMIT,
                       TAG="v0.6.0", PREVIOUS_TAG="v0.5.0", LATEST_COMMIT="b" * 40 if stale else COMMIT,
                       RELEASE_TARGET="b" * 40 if wrong_commit else COMMIT,
                       FAIL_UPLOAD="1" if fail else "0")
            result = subprocess.run([os.environ.get("RELEASE_TEST_BASH", "bash"), "-c", FAKE_GH + script],
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, state_path.read_text().strip(), (directory / "calls").read_text().splitlines()

    def test_immutable_publication_and_retries(self):
        for workflow, step in (("release.yml", "Publish GitHub Release"),):
            for state, fail in (("missing", False), ("draft", False), ("published", False), ("missing", True), ("draft", True)):
                with self.subTest(workflow=workflow, state=state, fail=fail):
                    result, final, calls = self.run_publication(workflow, step, state, fail)
                    self.assertEqual(result.returncode == 0, not fail, result.stderr)
                    self.assertEqual(final, "draft" if fail else "published")
                    mutations = [call for call in calls if call.startswith(("release create", "release upload", "release edit"))]
                    if state == "published":
                        self.assertEqual(mutations, [])
                    elif fail:
                        self.assertFalse(any(call.startswith("release edit") for call in mutations))
                    else:
                        self.assertTrue(mutations[-1].startswith("release edit"))
                    self.assertTrue(all("v0.6.0" in call for call in mutations))

    def test_old_main_run_is_not_promoted(self):
        result, final, calls = self.run_publication("release.yml", "Publish GitHub Release", "missing", stale=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(final, "missing")
        self.assertEqual(len(calls), 1)

    def test_draft_from_another_commit_is_not_modified(self):
        result, final, calls = self.run_publication("release.yml", "Publish GitHub Release", "draft", wrong_commit=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(final, "draft")
        self.assertFalse(any(call.startswith(("release upload", "release edit")) for call in calls))


class ManifestTests(unittest.TestCase):
    def test_all_six_assets_are_pinned_and_checksummed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for system in ("linux", "darwin", "windows"):
                for arch in ("amd64", "arm64"):
                    name = f"llama-nodrama-{system}-{arch}." + ("zip" if system == "windows" else "tar.gz")
                    (directory / name).write_bytes(name.encode())
            value = manifest(directory, "v0.6.0", COMMIT)
            self.assertEqual(len(value["assets"]), 6)
            for asset in value["assets"]:
                data = (directory / asset["name"]).read_bytes()
                self.assertEqual(asset["url"], "https://github.com/hangry-labs/llama.nodrama/releases/download/v0.6.0/" + asset["name"])
                self.assertEqual(asset["bytes"], len(data))
                self.assertEqual(asset["sha256"], hashlib.sha256(data).hexdigest())


class VersionTests(unittest.TestCase):
    def release(self, version, commit="b" * 40, draft=False, prerelease=False):
        return {"tag_name": version, "target_commitish": commit, "draft": draft, "prerelease": prerelease}

    def test_first_regular_release_ignores_previews(self):
        releases = [self.release("v0.5.0"), self.release("preview-" + COMMIT, COMMIT, prerelease=True)]
        result = plan_release("v0.6.0-SNAPSHOT", COMMIT, releases, [])
        self.assertEqual(result, {"version": "v0.6.0", "skip": False, "previous": "v0.5.0"})

    def test_patch_numbers_advance_within_selected_line(self):
        releases = [self.release("v0.6.2"), self.release("v0.6.9")]
        for source, expected in (("v0.6.0-SNAPSHOT", "v0.6.10"), ("v0.6.15-SNAPSHOT", "v0.6.15"), ("v0.7.0-SNAPSHOT", "v0.7.0"), ("v1.0.0-SNAPSHOT", "v1.0.0")):
            self.assertEqual(plan_release(source, COMMIT, releases, [])["version"], expected)

    def test_published_commit_rerun_skips_instead_of_allocating_version(self):
        result = plan_release("v0.6.0-SNAPSHOT", COMMIT, [self.release("v0.6.2", COMMIT)], [])
        self.assertEqual(result["version"], "v0.6.2")
        self.assertTrue(result["skip"])

    def test_draft_retry_reuses_its_version(self):
        result = plan_release("v0.6.0-SNAPSHOT", COMMIT, [self.release("v0.6.2", COMMIT, draft=True)], [])
        self.assertEqual(result["version"], "v0.6.2")
        self.assertFalse(result["skip"])

    def test_stale_draft_does_not_replace_a_newer_published_version(self):
        result = plan_release("v0.6.0-SNAPSHOT", COMMIT, [self.release("v0.6.2", COMMIT, draft=True), self.release("v0.6.3")], [])
        self.assertEqual(result["version"], "v0.6.4")

    def test_other_drafts_and_tags_reserve_numbers(self):
        result = plan_release("v0.6.0-SNAPSHOT", COMMIT, [self.release("v0.6.2", draft=True)], [{"ref": "refs/tags/v0.6.4"}])
        self.assertEqual(result["version"], "v0.6.5")

    def test_version_line_does_not_move_backwards(self):
        with self.assertRaises(ValueError):
            plan_release("v0.5.0-SNAPSHOT", COMMIT, [self.release("v0.6.0")], [])

    def test_invalid_versions_and_commits_rejected(self):
        for source, commit in (("main", COMMIT), ("v0.6.0-beta", COMMIT), ("v0.6.0-SNAPSHOT", "short")):
            with self.assertRaises(ValueError):
                plan_release(source, commit, [], [])


if __name__ == "__main__":
    unittest.main()
