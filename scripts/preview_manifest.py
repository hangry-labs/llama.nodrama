"""Describe the six CI binaries for the rolling preview updater."""
from pathlib import Path
import hashlib
import json
import os
import sys
import shutil
import re


def manifest(directory, version, commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or not re.fullmatch(r"v\d+\.\d+\.\d+(?:-SNAPSHOT)?", version):
        raise ValueError("Expected a full commit and repository version.")
    assets = []
    for system in ("linux", "darwin", "windows"):
        for architecture in ("amd64", "arm64"):
            name = f"llama-nodrama-{system}-{architecture}" + (".exe" if system == "windows" else "")
            path = directory / name
            published = f"llama-nodrama-{system}-{architecture}-{commit}" + (".exe" if system == "windows" else "")
            path = path.rename(directory / published)
            assets.append({"name": published, "os": system, "arch": architecture,
                           "url": "https://github.com/hangry-labs/llama.nodrama/releases/download/preview/" + published,
                           "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size})
    return {"schemaVersion": 1, "version": version, "commit": commit, "assets": assets}


if __name__ == "__main__":
    output = Path(sys.argv[1])
    value = manifest(output, Path("nodrama/VERSION").read_text().strip(), os.environ["BUILD_COMMIT"])
    (output / "update.json").write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    (output / "SHA256SUMS").write_text("".join(f"{a['sha256']}  {a['name']}\n" for a in value["assets"]), encoding="utf-8")
    for name in ("LICENSE", "BRAND_ASSETS.md", "THIRD_PARTY_NOTICES.md"):
        shutil.copyfile(name, output / name)
