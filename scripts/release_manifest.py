"""Describe the six platform archives in a regular immutable release."""
from pathlib import Path
import hashlib
import json
import os
import re
import sys


def manifest(directory, version, commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or not re.fullmatch(r"v\d+\.\d+\.\d+", version):
        raise ValueError("Expected a full commit and regular release version")
    assets = []
    for system in ("linux", "darwin", "windows"):
        for architecture in ("amd64", "arm64"):
            archive_format = "zip" if system == "windows" else "tar.gz"
            name = f"llama-nodrama-{system}-{architecture}.{archive_format}"
            path = directory / name
            assets.append({"name": name, "os": system, "arch": architecture, "format": archive_format,
                           "url": f"https://github.com/hangry-labs/llama.nodrama/releases/download/{version}/{name}",
                           "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size})
    return {"schemaVersion": 1, "version": version, "commit": commit, "assets": assets}


if __name__ == "__main__":
    output = Path(sys.argv[1])
    value = manifest(output, os.environ["RELEASE_VERSION"], os.environ["BUILD_COMMIT"])
    (output / "update.json").write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
