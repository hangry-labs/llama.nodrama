"""Plan the next regular patch release using read-only GitHub inventory."""
import json
import os
from pathlib import Path
import re
import sys


VERSION = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")


def version_parts(value):
    match = VERSION.fullmatch(value)
    return tuple(map(int, match.groups())) if match else None


def plan_release(source, commit, releases, tags):
    base = version_parts(source.removesuffix("-SNAPSHOT"))
    if base is None or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected repository version and full build commit")
    regular = [(version_parts(r.get("tag_name", "")), r) for r in releases
               if not r.get("prerelease") and version_parts(r.get("tag_name", ""))]
    published = [(v, r) for v, r in regular if not r.get("draft")]
    previous = max(published, key=lambda item: item[0])[1]["tag_name"] if published else ""
    if published and max(v for v, _ in published)[:2] > base[:2]:
        raise ValueError("Source version line is older than the latest regular release")
    same_commit = [(v, r) for v, r in regular if v[:2] == base[:2] and r.get("target_commitish") == commit]
    completed = [(v, r) for v, r in same_commit if not r.get("draft")]
    if completed:
        return {"version": max(completed, key=lambda item: item[0])[1]["tag_name"], "skip": True, "previous": previous}
    newest = max((v for v, _ in published), default=(-1, -1, -1))
    drafts = [(v, r) for v, r in same_commit if r.get("draft") and v > newest]
    if drafts:
        return {"version": max(drafts, key=lambda item: item[0])[1]["tag_name"], "skip": False, "previous": previous}
    used = [v[2] for v, _ in regular if v[:2] == base[:2]]
    for tag in tags:
        version = version_parts(tag["ref"].removeprefix("refs/tags/"))
        if version and version[:2] == base[:2]:
            used.append(version[2])
    patch = max(base[2], max(used, default=-1) + 1)
    return {"version": f"v{base[0]}.{base[1]}.{patch}", "skip": False, "previous": previous}


if __name__ == "__main__":
    # gh api --paginate --slurp emits one array per API page.
    releases = [item for page in json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")) for item in page]
    tags = [item for page in json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")) for item in page]
    result = plan_release(Path("VERSION").read_text(encoding="utf-8").strip(), os.environ["BUILD_COMMIT"], releases, tags)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for key, value in result.items():
            output.write(f"{key}={str(value).lower() if isinstance(value, bool) else value}\n")
    print(json.dumps(result))
