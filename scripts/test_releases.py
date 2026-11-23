"""Offline checks for release staging and immutable preview manifests (Bash required)."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

from preview_manifest import manifest


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
      case "$(cat "$FAKE_STATE")" in
        missing) return 1 ;;
        draft) echo true ;;
        published) echo false ;;
      esac ;;
    create)
      test "$(cat "$FAKE_STATE")" = missing || return 92
      case " $* " in *" --draft "*) ;; *) return 93 ;; esac
      echo draft > "$FAKE_STATE" ;;
    upload)
      test "$(cat "$FAKE_STATE")" = draft || return 94
      test "$FAIL_UPLOAD" = 0 || return 95
      echo yes > "$FAKE_UPLOADED" ;;
    edit)
      test "$(cat "$FAKE_STATE")" = draft || return 96
      test -f "$FAKE_UPLOADED" || return 97
      case " $* " in *" --draft=false "*) ;; *) return 98 ;; esac
      echo published > "$FAKE_STATE" ;;
    *) return 99 ;;
  esac
}
"""


class PublicationTests(unittest.TestCase):
    def run_publication(self, workflow, step, state, fail=False, stale=False):
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
                       TAG="v0.6.0", LATEST_COMMIT="b" * 40 if stale else COMMIT,
                       FAIL_UPLOAD="1" if fail else "0")
            result = subprocess.run([os.environ.get("RELEASE_TEST_BASH", "bash"), "-c", FAKE_GH + script],
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, state_path.read_text().strip(), (directory / "calls").read_text().splitlines()

    def test_immutable_publication_and_retries(self):
        for workflow, step in (("ci.yml", "Publish immutable tested preview"),
                               ("release.yml", "Publish GitHub Release")):
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
                    if workflow == "ci.yml":
                        self.assertTrue(all("preview-" + COMMIT in call for call in mutations))

    def test_old_main_run_is_not_promoted(self):
        result, final, calls = self.run_publication("ci.yml", "Publish immutable tested preview", "missing", stale=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(final, "missing")
        self.assertEqual(len(calls), 1)


class ManifestTests(unittest.TestCase):
    def test_all_six_assets_are_pinned_and_checksummed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for system in ("linux", "darwin", "windows"):
                for arch in ("amd64", "arm64"):
                    name = f"llama-nodrama-{system}-{arch}" + (".exe" if system == "windows" else "")
                    (directory / name).write_bytes(name.encode())
            value = manifest(directory, "v0.6.0-SNAPSHOT", COMMIT)
            self.assertEqual(len(value["assets"]), 6)
            for asset in value["assets"]:
                data = (directory / asset["name"]).read_bytes()
                self.assertEqual(asset["url"], f"https://github.com/hangry-labs/llama.nodrama/releases/download/preview-{COMMIT}/" + asset["name"])
                self.assertEqual(asset["bytes"], len(data))
                self.assertEqual(asset["sha256"], hashlib.sha256(data).hexdigest())


if __name__ == "__main__":
    unittest.main()
