#!/usr/bin/env python3
"""Pack an already checked/built, clean Pi source revision; never install or publish.

The SDK and agent-core must travel together. Core retains its upstream version
(like the separately vendored Pi AI package) so SDK shrinkwrap resolution can
share the explicit application pin; immutable filenames and source markers
identify the reviewed bytes. Downstream checks must verify actual resolution.
"""
import argparse
import base64
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile


def command(*args, cwd):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE).stdout.strip()


def repack(source, target, revision, sdk):
    with tarfile.open(source, "r:gz") as archive:
        members = archive.getmembers()
        if sum(item.size for item in members) > 100 * 1024 * 1024:
            raise ValueError("Unexpected package expansion size")
        entries = []
        for original in members:
            if not original.isfile() or not original.name.startswith("package/") or ".." in Path(original.name).parts:
                raise ValueError("Unexpected non-regular or unsafe package entry")
            item = copy.copy(original)
            body = archive.extractfile(original).read()
            if original.name in ("package/package.json", "package/npm-shrinkwrap.json"):
                value = json.loads(body)
                if value.get("version") != "0.84.1":
                    raise ValueError("Unexpected source package version")
                if sdk:
                    value["version"] = f"0.84.1-wayang.{revision[:8]}"
                    if "packages" in value:
                        value["packages"][""]["version"] = value["version"]
                if original.name == "package/package.json":
                    value["wayangSourceRevision"] = revision
                    if sdk:
                        value["wayangRequiredCoreSourceRevision"] = revision
                body = (json.dumps(value, indent=2) + "\n").encode()
            item.size = len(body)
            entries.append((item, body))
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for item, body in entries:
                archive.addfile(item, io.BytesIO(body))
    payload = output.getvalue()
    if target.is_symlink():
        raise ValueError("Refusing a symlink artifact destination")
    if target.exists():
        if not target.is_file():
            raise ValueError("Artifact destination must be a regular file")
        if target.read_bytes() != payload:
            raise ValueError(f"Refusing to overwrite different artifact: {target.name}")
    else:
        with target.open("xb") as destination:
            destination.write(payload)
    return {"file": target.name, "sha256": hashlib.sha256(payload).hexdigest(),
            "integrity": "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    output = args.output.resolve()
    revision = command("git", "rev-parse", "HEAD", cwd=source)
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Invalid source revision")
    if command("git", "status", "--porcelain", "--untracked-files=no", cwd=source):
        raise ValueError("Source tracked files must be clean after checks/build")
    packages = [("agent", "pi-agent-core", False), ("coding-agent", "pi-coding-agent", True)]
    for directory, name, _ in packages:
        root = source / "packages" / directory
        manifest = json.loads((root / "package.json").read_text())
        if manifest["name"] != "@earendil-works/" + name or manifest["version"] != "0.84.1":
            raise ValueError("Unexpected source package identity")
        if not (root / "dist/index.js").is_file():
            raise ValueError("Build the source offline before packing")
    output.mkdir(parents=True, exist_ok=True)
    artifacts = []
    # Only this newly created staging tree is automatically removed.
    with tempfile.TemporaryDirectory(prefix="wayang-pi-pack-") as staging:
        for directory, name, sdk in packages:
            packed = json.loads(command("npm", "pack", "--ignore-scripts", "--json",
                                        "--pack-destination", staging,
                                        cwd=source / "packages" / directory))
            record = packed[0] if isinstance(packed, list) else next(iter(packed.values()))
            filename = f"earendil-works-{name}-0.84.1-wayang.{revision[:8]}.tgz"
            artifacts.append(repack(Path(staging) / record["filename"], output / filename, revision, sdk))
    print(json.dumps({"sourceRevision": revision, "artifacts": artifacts}, indent=2))


if __name__ == "__main__":
    main()
