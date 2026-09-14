#!/usr/bin/env python3
"""Pack an already checked/built, clean Pi source revision; never install or publish.

The 0.85 SDK, core and AI travel together, bound to the catalog bytes they were
packed from. Core/AI retain upstream versions; SDK shrinkwrap graph entries
are preserved, not assumed to deduplicate. Downstream installation and actual
bundled-entrypoint checks remain mandatory. Failed packing stages are retained.

An optional --catalog-proof/--catalog-proof-sha256 pair still records the older
independently reviewed source-provenance.json bindings, but Wayang no longer
requires it: a clean, committed, offline-built source at a pinned revision is
deployable once its tests pass.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import fnmatch
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile


def command(*args, cwd):
    # Trusted git/npm only; avoid unbounded in-memory subprocess capture.
    with tempfile.TemporaryFile() as output:
        subprocess.run(args, cwd=cwd, check=True, stdout=output, timeout=180)
        output.seek(0)
        body = output.read(MAX_JSON_BYTES + 1)
        if len(body) > MAX_JSON_BYTES:
            raise ValueError("Command output exceeds bounded JSON/read limit")
        return body.decode("utf-8").strip()


def repack(source, target, revision, sdk):
    """Legacy generic 0.84 helper, not an unprovenanced route through main()."""
    source = source.parent.resolve() / source.name
    target = target.parent.resolve() / target.name
    entries = bounded_archive(regular_bytes(source, MAX_PACKAGE_BYTES))
    for name in ("package.json", "npm-shrinkwrap.json"):
        if name not in entries:
            continue
        body, mode = entries[name]
        value = parse_json(body, "legacy package/shrinkwrap")
        if value.get("version") != "0.84.1":
            raise ValueError("Unexpected source package version")
        if sdk:
            value["version"] = f"0.84.1-wayang.{revision[:8]}"
            if "packages" in value:
                value["packages"][""]["version"] = value["version"]
        if name == "package.json":
            value["wayangSourceRevision"] = revision
            if sdk:
                value["wayangRequiredCoreSourceRevision"] = revision
        entries[name] = ((json.dumps(value, indent=2) + "\n").encode(), mode)
    payload = serialize_entries(entries)
    if not destination_matches(target, payload):
        with target.open("xb") as destination:
            destination.write(payload)
    return {"file": target.name, "sha256": sha256(payload), "integrity": integrity(payload)}


MAX_PACKAGE_BYTES = 100 * 1024 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 10000
PACKAGES = {"ai": "pi-ai", "agent": "pi-agent-core", "coding-agent": "pi-coding-agent"}
LAZY_NAMES = ("anthropic", "bedrock-converse-stream", "github-copilot", "image-resize-worker",
              "kimi-coding", "openai-codex", "openrouter", "radius", "xai")
DERIVER_PATH = "packages/ai/scripts/derive-astra-catalog.ts"


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def integrity(body):
    return "sha512-" + base64.b64encode(hashlib.sha512(body).digest()).decode()


def full_hash(value, length=64):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{%d}" % length, value) is None:
        raise ValueError("Invalid full source revision or proof SHA256 hash")
    return value


def relative_name(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError("Unsafe package path or filename")
    if value.startswith("./"):
        value = value[2:]
    if any(part in ("", ".", "..") for part in value.split("/")) or any(ord(c) < 32 for c in value):
        raise ValueError("Unsafe package path or filename")
    return value


def regular_bytes(path, maximum=MAX_FILE_BYTES):
    """Bounded descriptor read; callers must keep canonical parent directories stable."""
    path = Path(path).absolute()
    if path.parent.resolve() != path.parent:
        raise ValueError(f"Unsafe symlink parent of regular file: {path.name}")
    def fingerprint(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
                info.st_mtime_ns, info.st_ctime_ns)
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
                raise ValueError(f"Unsafe or oversized regular file: {path.name}")
            body = stream.read(maximum + 1)
            after = os.fstat(stream.fileno())
            if len(body) > maximum or len(body) != before.st_size or fingerprint(before) != fingerprint(after):
                raise ValueError(f"File changed during bounded read: {path.name}")
            return body
    except OSError as error:
        raise ValueError(f"Missing or unsafe regular file: {path.name}") from error


def parse_json(body, label):
    if len(body) > MAX_JSON_BYTES:
        raise ValueError(f"Oversized {label} JSON")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate key in {label} JSON")
            result[key] = value
        return result
    def invalid_constant(_):
        raise ValueError(f"Invalid {label} JSON constant")
    try:
        return json.loads(body, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError(f"Invalid {label} JSON") from error


def read_object(path, label):
    value = parse_json(regular_bytes(path, MAX_JSON_BYTES), label)
    if not isinstance(value, dict):
        raise ValueError(f"Invalid {label} JSON object")
    return value


def signature(body):
    return {"sha256": sha256(body), "sizeBytes": len(body)}


def tree_snapshot(root):
    """No links, bounded traversal and total reads, including non-file entries."""
    if root.resolve() != root:
        raise ValueError("Unsafe symlink in snapshot root")
    result = {}
    count = 0
    total = 0
    folded = set()
    def visit(path, depth=0):
        nonlocal count, total
        count += 1
        if count > MAX_ENTRIES or depth > 64:
            raise ValueError("Package snapshot entry/depth limit exceeded")
        if path != root:
            name = relative_name(path.relative_to(root).as_posix())
            if name.casefold() in folded:
                raise ValueError("Case-colliding package snapshot paths")
            folded.add(name.casefold())
        try:
            info = path.lstat()
        except OSError as error:
            raise ValueError(f"Missing snapshot entry: {path.name}") from error
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(path) as entries:
                for entry in entries:
                    visit(Path(entry.path), depth + 1)
        elif stat.S_ISREG(info.st_mode):
            name = relative_name(path.relative_to(root).as_posix())
            if total + info.st_size > MAX_PACKAGE_BYTES:
                raise ValueError("Package snapshot size limit exceeded")
            body = regular_bytes(path)
            total += len(body)
            result[name] = signature(body)
        else:
            raise ValueError(f"Unsafe non-regular snapshot entry: {path.name}")
    visit(root)
    return result


def source_identity(source):
    revision = full_hash(command("git", "rev-parse", "HEAD", cwd=source), 40)
    # Include nonignored untracked source at both prepack and prepublication
    # checks. Git-ignored build outputs/dependencies remain allowed.
    if command("git", "status", "--porcelain", "--untracked-files=all", cwd=source):
        raise ValueError("Source must be clean, including nonignored untracked files, after checks/build")
    return revision


def catalog_contract(source, proof_path, expected_hash, revision):
    full_hash(expected_hash)
    proof_body = regular_bytes(proof_path, MAX_JSON_BYTES)
    if sha256(proof_body) != expected_hash:
        raise ValueError("Catalog proof SHA256 hash mismatch")
    proof = parse_json(proof_body, "catalog proof")
    if not isinstance(proof, dict) or type(proof.get("schemaVersion")) is not int or proof["schemaVersion"] != 1:
        raise ValueError("Unsupported catalog proof schema")
    for key in ("sourceRevision", "runtimePortRevision", "upstreamRevision"):
        full_hash(proof.get(key), 40)
    for key in ("deriverSha256", "publishedArchiveSha256", "approvedArchiveSha256", "inputProofSha256",
                "derivationReportSha256", "outputManifestSha256"):
        full_hash(proof.get(key))
    if proof["sourceRevision"] != revision or proof.get("deriverPath") != DERIVER_PATH:
        raise ValueError("Catalog proof source revision or deriver path mismatch")
    deriver = regular_bytes(source / DERIVER_PATH)
    if sha256(deriver) != proof["deriverSha256"]:
        raise ValueError("Catalog deriver hash mismatch")
    verification = proof.get("verification")
    if not isinstance(verification, dict) or any(verification.get(key) is not True for key in (
        "sourceClean", "committedSourceRepeatIdentical", "materializedBuildCatalogMatchesRepeat",
        "inputArchivesUnchanged", "sourceChecksPassed", "offlineBuildPassed",
        "modularAndBundledWorktreeSmokesPassed",
    )):
        raise ValueError("Catalog provenance verification did not pass")
    for key in ("aiTestsPassed", "coreTestsPassed", "sdkTestsPassed", "sdkTestsSkipped"):
        value = verification.get(key)
        if type(value) is not int or value < (0 if key == "sdkTestsSkipped" else 1):
            raise ValueError("Invalid catalog verification test counts")
    report_body = regular_bytes(proof_path.parent / "derivation.json", MAX_JSON_BYTES)
    if sha256(report_body) != proof["derivationReportSha256"]:
        raise ValueError("Catalog derivation report hash mismatch")
    report = parse_json(report_body, "catalog derivation")
    if not isinstance(report, dict) or type(report.get("schemaVersion")) is not int or report["schemaVersion"] != 1:
        raise ValueError("Unsupported catalog derivation schema")
    if report.get("inputProofSha256") != proof["inputProofSha256"]:
        raise ValueError("Catalog input proof hash mismatch")
    inputs = report.get("inputs", {})
    for key, field in (("published", "publishedArchiveSha256"), ("approved", "approvedArchiveSha256")):
        if not isinstance(inputs, dict) or not isinstance(inputs.get(key), dict) or inputs[key].get("archiveSha256") != proof[field]:
            raise ValueError("Catalog input archive hash mismatch")
    data = tree_snapshot(proof_path.parent / "data")
    output_files = report.get("outputFiles")
    if not isinstance(output_files, dict) or data != output_files:
        raise ValueError("Catalog provider files differ from derivation snapshot")
    if data.get(".manifest.json", {}).get("sha256") != proof["outputManifestSha256"]:
        raise ValueError("Catalog manifest hash mismatch")
    manifest = read_object(proof_path.parent / "data/.manifest.json", "catalog manifest")
    providers = {name: item["sha256"] for name, item in data.items() if name != ".manifest.json"}
    if (manifest.get("schemaVersion") != 3 or manifest.get("files") != providers
            or any("/" in name or not name.endswith(".json") for name in providers)):
        raise ValueError("Catalog manifest provider inventory mismatch")
    full_hash(manifest.get("structureHash"))
    unchanged = report.get("unchangedProviderFiles")
    additions = report.get("additions")
    if (not isinstance(unchanged, list) or any(not isinstance(name, str) for name in unchanged)
            or len(set(unchanged)) != len(unchanged) or not isinstance(additions, list)):
        raise ValueError("Invalid catalog derivation provider counts")
    for field, count in (("providerFiles", len(providers)), ("byteIdenticalProviderFiles", len(unchanged)),
                         ("semanticModelAdditions", len(additions))):
        if type(proof.get(field)) is not int or proof[field] != count:
            raise ValueError("Catalog proof provider counts mismatch")
    published_files = inputs["published"].get("files", {})
    if not isinstance(published_files, dict):
        raise ValueError("Invalid published catalog input file inventory")
    for item in additions:
        if not isinstance(item, dict) or not isinstance(item.get("provider"), str) or item["provider"] + ".json" not in providers:
            raise ValueError("Invalid catalog addition provider")
        full_hash(item.get("definitionSha256"))
    for name in unchanged:
        if name not in providers or published_files.get(name) != data[name]:
            raise ValueError("Catalog unchanged provider hash mismatch")
    for tree in ("src", "dist"):
        if tree_snapshot(source / "packages/ai" / tree / "providers/data") != data:
            raise ValueError(f"AI {tree} catalog provider snapshot mismatch")
    return proof, data


def catalog_manifest_sha256(source):
    """Bind the packed catalog bytes directly, with no external attestation file.

    Wayang deploys on tests pass, so the packed triplet records what the source
    catalog actually contains (src/dist inventory plus manifest hash) rather than
    a separately reviewed source-provenance.json.
    """
    data = None
    for tree in ("src", "dist"):
        snapshot = tree_snapshot(source / "packages" / "ai" / tree / "providers/data")
        if data is None:
            data = snapshot
        elif snapshot != data:
            raise ValueError("AI src/dist catalog provider snapshot mismatch")
    if data is None or data.get(".manifest.json", {}).get("sha256") != sha256(
            regular_bytes(source / "packages/ai/dist/providers/data/.manifest.json", MAX_JSON_BYTES)):
        raise ValueError("Catalog manifest hash mismatch")
    manifest = read_object(source / "packages/ai/dist/providers/data/.manifest.json", "catalog manifest")
    providers = {name: item["sha256"] for name, item in data.items() if name != ".manifest.json"}
    if (manifest.get("schemaVersion") != 3 or manifest.get("files") != providers
            or any("/" in name or not name.endswith(".json") for name in providers)):
        raise ValueError("Catalog manifest provider inventory mismatch")
    return data[".manifest.json"]["sha256"]


def package_snapshot(root, manifest, sdk):
    # Capture publishable roots before npm; never traverse node_modules or private state.
    selectors = manifest.get("files", ["dist"])
    if not isinstance(selectors, list) or len(selectors) > 100 or any(not isinstance(item, str) for item in selectors):
        raise ValueError("Invalid package files metadata")
    result = {}
    for selector in dict.fromkeys(["dist", *selectors, "package.json", "README.md", "LICENSE", "LICENSE.md",
                                   *(["npm-shrinkwrap.json"] if sdk else [])]):
        selector = relative_name(selector)
        if selector.split("/")[0] in ("node_modules", ".git", "src", "scripts") or any(c in selector for c in "*?["):
            raise ValueError("Unsupported package files path; review the upstream pack contract")
        path = root / selector
        if not path.exists() and not path.is_symlink():
            if selector in ("dist", "package.json", "npm-shrinkwrap.json"):
                raise ValueError(f"Missing required package entry: {selector}")
            continue
        if path.is_dir() and not path.is_symlink():
            result.update({selector + "/" + name: item for name, item in tree_snapshot(path).items()})
        else:
            result[selector] = signature(regular_bytes(path))
        if len(result) > MAX_ENTRIES or sum(item["sizeBytes"] for item in result.values()) > MAX_PACKAGE_BYTES:
            raise ValueError("Package snapshot exceeds bounds")
    return result


def require_entry(snapshot, value):
    name = relative_name(value)
    if "*" in name:
        if not any(fnmatch.fnmatchcase(key, name) for key in snapshot):
            raise ValueError(f"Missing declared wildcard entry: {name}")
    elif name not in snapshot:
        raise ValueError(f"Missing declared runtime/type entry: {name}")
    return name


def validate_package(root, directory):
    manifest = read_object(root / "package.json", "package")
    if manifest.get("name") != "@earendil-works/" + PACKAGES[directory] or manifest.get("version") != "0.85.0":
        raise ValueError("Unexpected source package identity or version")
    sdk = directory == "coding-agent"
    snapshot = package_snapshot(root, manifest, sdk)
    if relative_name(manifest.get("main")) != "dist/index.js":
        raise ValueError("Unexpected modular main entry")
    require_entry(snapshot, manifest["main"])
    require_entry(snapshot, manifest.get("types"))
    exports = manifest.get("exports")
    if (not isinstance(exports, dict) or not isinstance(exports.get("."), dict)
            or exports["."].get("import") != "./dist/index.js"
            or exports["."].get("types") != "./dist/index.d.ts"):
        raise ValueError("Missing or wrong modular runtime/type exports")
    wildcard_targets = {}
    def targets(value, export_name, conditions=()):
        if (sdk and export_name == "./experimental/plugin" and conditions == ("source",)
                and value == "./src/experimental/plugin.ts"):
            return
        if isinstance(value, str):
            template = require_entry(snapshot, value)
            if "*" in template:
                if template.count("*") != 1:
                    raise ValueError("Unsupported wildcard export target")
                pattern = re.compile("^" + re.escape(template).replace(r"\*", "(.+)") + "$")
                captures = {match.group(1) for name in snapshot if (match := pattern.fullmatch(name))}
                wildcard_targets.setdefault(export_name, []).append(captures)
        elif isinstance(value, dict) and value:
            for key, child in value.items():
                targets(child, export_name, conditions + (key,))
        elif isinstance(value, list) and value:
            for child in value:
                targets(child, export_name, conditions)
        else:
            raise ValueError("Unsupported package export target")
    for name, value in exports.items():
        targets(value, name)
    for captures in wildcard_targets.values():
        if any(items != captures[0] for items in captures[1:]):
            raise ValueError("Missing matching wildcard runtime/type export target")
    bins = manifest.get("bin", {})
    if not isinstance(bins, dict):
        raise ValueError("Unsupported declared bin metadata")
    for target in bins.values():
        require_entry(snapshot, target)
    assets = {}
    if sdk:
        if bins.get("pi") != "dist/bundle/cli.js" or exports.get("./rpc-entry") != {"import": "./dist/bundle/rpc-entry.js"}:
            raise ValueError("SDK requires declared bundled CLI and RPC entries; no modular fallback")
        lock = read_object(root / "npm-shrinkwrap.json", "shrinkwrap")
        lock_root = lock.get("packages", {}).get("") if isinstance(lock.get("packages"), dict) else None
        for item in (lock, lock_root):
            if not isinstance(item, dict) or item.get("name") != manifest["name"] or item.get("version") != "0.85.0":
                raise ValueError("SDK shrinkwrap root identity/version mismatch")
        if lock.get("lockfileVersion") != 3:
            raise ValueError("Unsupported SDK shrinkwrap lock version")
        for name in ("cli", "rpc-entry", "index", "client", "coordinator"):
            require_entry(snapshot, f"dist/bundle/{name}.js")
        for name in LAZY_NAMES:
            require_entry(snapshot, f"dist/bundle/chunks/{name}.js")
        if not any(re.fullmatch(r"dist/bundle/chunks/chunk-[A-Za-z0-9_-]+\.js", name) for name in snapshot):
            raise ValueError("Missing bundled shared chunks")
        # Literal relative imports supplement the full dist inventory and fixed lazy closure.
        # This is not a JavaScript interpreter or an installed-runtime behavior proof.
        for name in snapshot:
            if name.startswith("dist/bundle/") and name.endswith(".js"):
                text = regular_bytes(root / name).decode("utf-8")
                for target in re.findall(r'''(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew\s+URL\(\s*)["'](\.{1,2}/[^"']+\.js)["']''', text):
                    resolved = (root / name).parent.joinpath(target).resolve()
                    if not resolved.is_relative_to(root):
                        raise ValueError("Unsafe bundled import target")
                    require_entry(snapshot, resolved.relative_to(root).as_posix())
        for folder, pattern in (("modes/interactive/theme", "*.json"), ("modes/interactive/assets", "*.png"),
                                ("core/export-html/vendor", "*.js")):
            found = tree_snapshot(root / "src" / folder)
            selected = {folder + "/" + name: item for name, item in found.items() if fnmatch.fnmatchcase(name, pattern)}
            if not selected:
                raise ValueError("Missing source runtime assets")
            assets.update(selected)
        for name in ("template.html", "template.css", "template.js"):
            name = "core/export-html/" + name
            assets[name] = signature(regular_bytes(root / "src" / name))
        for name, item in assets.items():
            if snapshot.get("dist/" + name) != item:
                raise ValueError(f"Missing or changed runtime asset: {name}")
    return manifest, snapshot, assets


def bounded_archive(payload):
    # Cap compressed input AND total tar expansion, including PAX metadata/padding.
    if len(payload) > MAX_PACKAGE_BYTES:
        raise ValueError("Oversized compressed package")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as compressed:
            expanded = compressed.read(MAX_PACKAGE_BYTES + 1)
        if len(expanded) > MAX_PACKAGE_BYTES:
            raise ValueError("Package decompression limit exceeded")
        result = {}
        folded = set()
        with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
            for member in archive:
                name = relative_name(member.name)
                if (name != member.name or not name.startswith("package/") or not member.isfile()
                        or member.size > MAX_FILE_BYTES or member.size < 0 or len(result) >= MAX_ENTRIES
                        or name.casefold() in folded):
                    raise ValueError("Unsafe, duplicate or oversized package archive entry")
                folded.add(name.casefold())
                body = archive.extractfile(member).read(MAX_FILE_BYTES + 1)
                if len(body) != member.size:
                    raise ValueError("Package archive member size mismatch")
                result[name[8:]] = (body, member.mode)
        return result
    except (OSError, EOFError, tarfile.TarError) as error:
        raise ValueError("Invalid bounded package archive") from error


def triplet_payload(entries, directory, revision, catalog_manifest, proof, proof_hash):
    entries = dict(entries)
    manifest = parse_json(entries["package.json"][0], "package")
    manifest["wayangSourceRevision"] = revision
    manifest["wayangAiCatalogManifestSha256"] = catalog_manifest
    if directory != "ai":
        manifest["wayangRequiredAiSourceRevision"] = revision
    elif proof is not None:
        for key, field in (("wayangAiCatalogDerivationSha256", "derivationReportSha256"),
                           ("wayangAiPublishedArchiveSha256", "publishedArchiveSha256"),
                           ("wayangAiApprovedArchiveSha256", "approvedArchiveSha256"),
                           ("wayangAiDeriverSha256", "deriverSha256")):
            manifest[key] = proof[field]
        manifest["wayangAiCatalogProvenanceSha256"] = proof_hash
    if directory == "coding-agent":
        manifest["version"] = f"0.85.0-wayang.{revision[:8]}"
        manifest["wayangRequiredCoreSourceRevision"] = revision
        lock = parse_json(entries["npm-shrinkwrap.json"][0], "shrinkwrap")
        lock["version"] = lock["packages"][""]["version"] = manifest["version"]
        entries["npm-shrinkwrap.json"] = ((json.dumps(lock, indent=2) + "\n").encode(), 0o644)
    entries["package.json"] = ((json.dumps(manifest, indent=2) + "\n").encode(), 0o644)
    # Upstream npm archives may store bins as 0644; seal verified bytes as executable.
    for target in manifest.get("bin", {}).values():
        target = relative_name(target)
        if target not in entries:
            raise ValueError("Missing packed declared bin entry")
        entries[target] = (entries[target][0], 0o755)
    return serialize_entries(entries)


def serialize_entries(entries):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, (body, mode) in sorted(entries.items()):
                item = tarfile.TarInfo("package/" + name)
                item.size = len(body)
                item.mode = 0o755 if mode & 0o111 else 0o644
                archive.addfile(item, io.BytesIO(body))
    payload = output.getvalue()
    sealed = bounded_archive(payload)
    if {name: body for name, (body, _) in sealed.items()} != {name: body for name, (body, _) in entries.items()}:
        raise ValueError("Repacked archive byte verification failed")
    return payload


def destination_matches(path, payload):
    if path.is_symlink():
        raise ValueError("Refusing a symlink artifact destination")
    if path.exists():
        if regular_bytes(path, MAX_PACKAGE_BYTES) != payload:
            raise ValueError(f"Refusing to overwrite different artifact: {path.name}")
        return True
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--catalog-proof", type=Path,
                        help="Optional reviewed source-provenance.json; derivation.json and data/ must be siblings")
    parser.add_argument("--catalog-proof-sha256",
                        help="Optional independently recorded full lowercase SHA256 of reviewed proof bytes")
    args = parser.parse_args()
    if (args.catalog_proof is None) != (args.catalog_proof_sha256 is None):
        raise ValueError("Supply both --catalog-proof and --catalog-proof-sha256, or neither")
    checked = [args.source, args.output]
    if args.catalog_proof is not None:
        checked.append(args.catalog_proof)
    for path in checked:
        if path.is_symlink():
            raise ValueError("Refusing a symlink source/proof/output destination")
    source = args.source.resolve(strict=True)
    output = args.output.resolve()
    proof_path = None
    if args.catalog_proof is not None:
        proof_path = args.catalog_proof.parent.resolve(strict=True) / args.catalog_proof.name
        if output.is_relative_to(source) or output.is_relative_to(proof_path.parent):
            raise ValueError("Artifact output must be outside source and catalog inputs")
    elif output.is_relative_to(source):
        raise ValueError("Artifact output must be outside source and catalog inputs")
    if output.exists() and not output.is_dir():
        raise ValueError("Artifact output destination must be a directory")
    revision = source_identity(source)
    catalog_manifest = catalog_manifest_sha256(source)
    proof = None
    catalog = None
    if proof_path is not None:
        proof, catalog = catalog_contract(source, proof_path, args.catalog_proof_sha256, revision)
    snapshots = {directory: validate_package(source / "packages" / directory, directory) for directory in PACKAGES}
    # Retain all failed npm/repack stages. Only our own successful staging tree is removed.
    staging = Path(tempfile.mkdtemp(prefix="wayang-pi-pack-")).resolve()
    try:
        artifacts = []
        payloads = []
        for directory, name in PACKAGES.items():
            root = source / "packages" / directory
            packed = parse_json(command("npm", "pack", "--ignore-scripts", "--json", "--pack-destination",
                                        str(staging), cwd=root), "npm pack record")
            # npm 12 returns a package-keyed object; retain the legacy singleton array.
            if isinstance(packed, dict) and len(packed) == 1:
                key, record = next(iter(packed.items()))
                if (key != "@earendil-works/" + name or not isinstance(record, dict)
                        or record.get("name") != key):
                    raise ValueError("npm pack record key or identity mismatch")
            elif isinstance(packed, list) and len(packed) == 1 and isinstance(packed[0], dict):
                record = packed[0]
            else:
                raise ValueError("Expected exactly one npm pack record")
            filename = relative_name(record.get("filename"))
            if "/" in filename or filename != record["filename"] or not filename.endswith(".tgz"):
                raise ValueError("npm pack filename must be a safe basename")
            payload = regular_bytes(staging / filename, MAX_PACKAGE_BYTES)
            if (record.get("name") != "@earendil-works/" + name or record.get("version") != "0.85.0"
                    or type(record.get("size")) is not int or record["size"] != len(payload)
                    or record.get("integrity") != integrity(payload)
                    or record.get("shasum") != hashlib.sha1(payload).hexdigest()):
                raise ValueError("npm pack identity, size or integrity mismatch")
            entries = bounded_archive(payload)
            manifest, snapshot, _ = snapshots[directory]
            if any(snapshot.get(key) != signature(body) for key, (body, _) in entries.items()):
                raise ValueError("npm pack changed or added entries outside the source snapshot")
            # npm 12 packlist omits shrinkwrap; restore only the validated SDK source bytes.
            if directory == "coding-agent" and "npm-shrinkwrap.json" not in entries:
                lock_body = regular_bytes(root / "npm-shrinkwrap.json", MAX_JSON_BYTES)
                if signature(lock_body) != snapshot.get("npm-shrinkwrap.json"):
                    raise ValueError("SDK shrinkwrap changed from the validated source snapshot")
                entries["npm-shrinkwrap.json"] = (lock_body, 0o644)
            required = {key for key in snapshot if key.startswith("dist/") or key in ("package.json", "npm-shrinkwrap.json")}
            if not required.issubset(entries):
                raise ValueError("npm pack omitted required snapshot entries")
            payload = triplet_payload(entries, directory, revision, catalog_manifest, proof, args.catalog_proof_sha256)
            suffix = sha256(payload)[:8] if directory == "ai" else revision[:8]
            filename = f"earendil-works-{name}-0.85.0-wayang.{suffix}.tgz"
            # Keep the verified final bytes in the stage as well for failed-stage review.
            with (staging / filename).open("xb") as stream:
                stream.write(payload)
            artifacts.append({"file": filename, "sha256": sha256(payload), "integrity": integrity(payload), "sizeBytes": len(payload)})
            payloads.append((output / filename, payload))
        if source_identity(source) != revision:
            raise ValueError("Source revision changed during pack")
        if catalog_manifest_sha256(source) != catalog_manifest:
            raise ValueError("Catalog snapshot changed during pack")
        if proof_path is not None and catalog_contract(
                source, proof_path, args.catalog_proof_sha256, revision) != (proof, catalog):
            raise ValueError("Catalog proof changed during pack")
        if {directory: validate_package(source / "packages" / directory, directory) for directory in PACKAGES} != snapshots:
            raise ValueError("Source package snapshot changed during pack")
        if output.is_symlink():
            raise ValueError("Output destination changed to a symlink")
        output.mkdir(parents=True, exist_ok=True)
        # Preflight the whole cohort before publishing any member; never overwrite.
        for path, payload in payloads:
            destination_matches(path, payload)
        for path, payload in payloads:
            if not destination_matches(path, payload):
                with path.open("xb") as stream:
                    stream.write(payload)
        print(json.dumps({"sourceRevision": revision, "artifacts": artifacts}, indent=2))
    except BaseException:
        print(f"Failed Pi artifact stage retained: {staging}", file=sys.stderr)
        raise
    else:
        shutil.rmtree(staging)


if __name__ == "__main__":
    main()
