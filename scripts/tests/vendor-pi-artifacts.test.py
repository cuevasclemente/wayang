import base64
import copy
import hashlib
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("vendor_pi", Path(__file__).resolve().parents[1] / "vendor-pi-artifacts.py")
vendor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vendor)
REVISION = "a" * 40


def source_archive(path, unsafe=False):
    entries = {
        "package/package.json": json.dumps({"name": "synthetic", "version": "0.84.1"}).encode(),
        "package/npm-shrinkwrap.json": json.dumps({"version": "0.84.1", "packages": {"": {"version": "0.84.1"}}}).encode(),
        "package/dist/index.js": b"// public synthetic fixture\n",
    }
    if unsafe:
        entries["package/../outside"] = b"not extracted"
    with tarfile.open(path, "w:gz") as archive:
        for name, body in entries.items():
            item = tarfile.TarInfo(name)
            item.size = len(body)
            item.mode = 0o644
            archive.addfile(item, io.BytesIO(body))


class VendorArtifactTests(unittest.TestCase):
    def test_reproducible_source_markers_and_sdk_lock_version(self):
        with tempfile.TemporaryDirectory(prefix="wayang-pack-test-") as temporary:
            root = Path(temporary)
            source = root / "source.tgz"
            source_archive(source)
            for sdk in (False, True):
                first = root / f"first-{sdk}.tgz"
                second = root / f"second-{sdk}.tgz"
                record = vendor.repack(source, first, REVISION, sdk)
                vendor.repack(source, second, REVISION, sdk)
                self.assertEqual(first.read_bytes(), second.read_bytes())
                self.assertEqual(record, vendor.repack(source, first, REVISION, sdk))
                with tarfile.open(first, "r:gz") as archive:
                    package = json.load(archive.extractfile("package/package.json"))
                    lock = json.load(archive.extractfile("package/npm-shrinkwrap.json"))
                    self.assertEqual(package["wayangSourceRevision"], REVISION)
                    version = "0.84.1-wayang.aaaaaaaa" if sdk else "0.84.1"
                    self.assertEqual(package["version"], version)
                    self.assertEqual(lock["version"], version)
                    self.assertEqual(lock["packages"][""]["version"], version)
                    if sdk:
                        self.assertEqual(package["wayangRequiredCoreSourceRevision"], REVISION)
                    self.assertEqual(archive.extractfile("package/dist/index.js").read(), b"// public synthetic fixture\n")

    def test_legacy_repack_does_not_promote_declared_bin_modes(self):
        with tempfile.TemporaryDirectory(prefix="wayang-pack-test-") as temporary:
            root = Path(temporary)
            source = root / "source.tgz"
            body = b"#!/usr/bin/env node\n// synthetic legacy CLI\n"
            with tarfile.open(source, "w:gz") as archive:
                for name, payload in {
                    "package/package.json": json.dumps({
                        "name": "synthetic", "version": "0.84.1", "bin": {"synthetic": "dist/cli.js"},
                    }).encode(),
                    "package/dist/cli.js": body,
                }.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(payload)
                    member.mode = 0o644
                    archive.addfile(member, io.BytesIO(payload))
            for sdk in (False, True):
                target = root / f"legacy-{sdk}.tgz"
                vendor.repack(source, target, REVISION, sdk)
                with tarfile.open(target, "r:gz") as archive:
                    self.assertEqual(archive.getmember("package/dist/cli.js").mode, 0o644)
                    self.assertEqual(archive.extractfile("package/dist/cli.js").read(), body)

    def test_rejects_unsafe_names_and_never_overwrites_or_follows_destinations(self):
        with tempfile.TemporaryDirectory(prefix="wayang-pack-test-") as temporary:
            root = Path(temporary)
            source, target = root / "source.tgz", root / "target.tgz"
            source_archive(source, unsafe=True)
            with self.assertRaises(ValueError):
                vendor.repack(source, target, REVISION, True)
            self.assertFalse(target.exists())
            source_archive(source)
            target.write_bytes(b"existing fixture")
            with self.assertRaises(ValueError):
                vendor.repack(source, target, REVISION, True)
            self.assertEqual(target.read_bytes(), b"existing fixture")
            link = root / "link.tgz"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                vendor.repack(source, link, REVISION, True)
            self.assertEqual(target.read_bytes(), b"existing fixture")


# New-cohort tests exercise main(), not a permissive generic repack helper.
# Source, proof and npm output are synthetic. Most Git replies are mocked;
# the explicit cleanliness regressions below use only isolated disposable Git repos.
PACKAGE_NAMES = {
    "ai": "@earendil-works/pi-ai",
    "agent": "@earendil-works/pi-agent-core",
    "coding-agent": "@earendil-works/pi-coding-agent",
}
LAZY_NAMES = (
    "anthropic", "bedrock-converse-stream", "github-copilot",
    "image-resize-worker", "kimi-coding", "openai-codex", "openrouter",
    "radius", "xai",
)


def json_bytes(value):
    return (json.dumps(value, indent=2) + "\n").encode()


def digest(body):
    return hashlib.sha256(body).hexdigest()


def put(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)


def archive_entries(path):
    with tarfile.open(path, "r:gz") as archive:
        return {member.name: archive.extractfile(member).read() for member in archive.getmembers()}


class TripletFixture:
    def __init__(self, root):
        root = root.resolve()
        self.source = root / "source"
        self.output = root / "output"
        self.catalog = root / "catalog"
        self.proof_path = self.catalog / "source-provenance.json"
        self.commands = []
        self.stages = []
        self.dirty = ""
        self.revision = REVISION
        self.pack_mutator = None
        self.pack_member_mutator = None
        self.returned_filename = None
        self.record_mutator = None
        self.pack_output = lambda name, record: [record]
        self.pack_order_reverse = False
        self.source_manifests = {}
        for directory, name in PACKAGE_NAMES.items():
            manifest = {
                "name": name, "version": "0.85.0", "type": "module",
                "main": "./dist/index.js", "types": "./dist/index.d.ts",
                "exports": {".": {"import": "./dist/index.js", "types": "./dist/index.d.ts"}},
                "dependencies": {"typebox": "1.3.7"},
                "peerDependencies": {"synthetic-peer": "^1.0.0"},
                "optionalDependencies": {"synthetic-optional": "1.2.3"},
            }
            if directory != "ai":
                manifest["dependencies"][PACKAGE_NAMES["ai"]] = "^0.85.0"
            if directory == "coding-agent":
                manifest["dependencies"][PACKAGE_NAMES["agent"]] = "^0.85.0"
                manifest["bin"] = {"pi": "dist/bundle/cli.js"}
                manifest["exports"]["./rpc-entry"] = {"import": "./dist/bundle/rpc-entry.js"}
                manifest["exports"]["./experimental/plugin"] = {
                    "source": "./src/experimental/plugin.ts",
                    "types": "./dist/experimental/plugin.d.ts",
                    "import": "./dist/experimental/plugin.js",
                }
            elif directory == "ai":
                manifest["bin"] = {"pi-ai": "dist/cli.js"}
            self.source_manifests[directory] = copy.deepcopy(manifest)
            self.set_manifest(directory, manifest)
            for filename in ("dist/index.js", "dist/index.d.ts", "README.md"):
                put(self.package(directory) / filename, b"// synthetic package fixture\n")
        put(self.package("ai") / "dist/cli.js", b"// synthetic AI CLI\n")
        sdk = self.package("coding-agent")
        for filename in (
            "dist/cli.js", "dist/rpc-entry.js", "dist/client/index.js", "dist/client/index.d.ts",
            "dist/experimental/plugin.js", "dist/experimental/plugin.d.ts",
            "dist/bundle/cli.js", "dist/bundle/rpc-entry.js", "dist/bundle/index.js",
            "dist/bundle/client.js", "dist/bundle/coordinator.js",
        ):
            put(sdk / filename, b'import "./chunks/chunk-SYNTHETIC.js";\n' if "/bundle/" in filename
                else b"// synthetic modular entry\n")
        put(sdk / "dist/bundle/chunks/chunk-SYNTHETIC.js", b"export const fixture = true;\n")
        for name in LAZY_NAMES:
            put(sdk / f"dist/bundle/chunks/{name}.js", b"// synthetic lazy implementation\n")
        for filename in (
            "modes/interactive/theme/dark.json", "modes/interactive/theme/light.json",
            "modes/interactive/assets/pi.png", "core/export-html/template.html",
            "core/export-html/template.css", "core/export-html/template.js",
            "core/export-html/vendor/marked.js",
        ):
            put(sdk / "src" / filename, b"synthetic asset\n")
            put(sdk / "dist" / filename, b"synthetic asset\n")
        self.lock = {
            "name": PACKAGE_NAMES["coding-agent"], "version": "0.85.0",
            "lockfileVersion": 3, "requires": True,
            "packages": {
                "": copy.deepcopy(self.source_manifests["coding-agent"]),
                "node_modules/@earendil-works/pi-ai": {
                    "version": "0.85.0", "resolved": "https://registry.invalid/pi-ai.tgz",
                    "integrity": "sha512-" + base64.b64encode(b"synthetic lock fixture").decode(),
                },
            },
        }
        put(sdk / "npm-shrinkwrap.json", json_bytes(self.lock))
        deriver = b"// inert synthetic deriver identity; never execute\n"
        put(self.source / "packages/ai/scripts/derive-astra-catalog.ts", deriver)
        providers = {
            "openai.json": json_bytes({"synthetic-model": {"id": "synthetic-model"}}),
            "unchanged.json": json_bytes({"synthetic-other": {"id": "synthetic-other"}}),
        }
        catalog_manifest = json_bytes({
            "schemaVersion": 3, "generatedAt": "2026-09-07T00:00:00.000Z",
            "structureHash": "b" * 64,
            "files": {name: digest(body) for name, body in providers.items()},
        })
        self.catalog_files = {".manifest.json": catalog_manifest, **providers}
        for name, body in self.catalog_files.items():
            put(self.catalog / "data" / name, body)
            for tree in ("src", "dist"):
                put(self.package("ai") / tree / "providers/data" / name, body)
        self.report = {
            "schemaVersion": 1, "generatedAt": "2026-09-07T00:00:00.000Z",
            "inputProofSha256": "c" * 64,
            "inputs": {
                "published": {"archiveSha256": "d" * 64, "archiveSizeBytes": 123,
                              "files": {"unchanged.json": {"sha256": digest(providers["unchanged.json"]),
                                                            "sizeBytes": len(providers["unchanged.json"])}}},
                "approved": {"archiveSha256": "e" * 64, "archiveSizeBytes": 456, "files": {}},
            },
            "additions": [{"provider": "openai", "api": "openai-responses", "id": "synthetic-model",
                           "definitionSha256": "f" * 64, "status": "preserved-approved-metadata"}],
            "unchangedProviderFiles": ["unchanged.json"],
            "outputFiles": {name: {"sha256": digest(body), "sizeBytes": len(body)}
                            for name, body in self.catalog_files.items()},
        }
        put(self.catalog / "derivation.json", json_bytes(self.report))
        self.proof = {
            "schemaVersion": 1, "sourceRevision": REVISION,
            "runtimePortRevision": "1" * 40, "upstreamRevision": "2" * 40,
            "deriverPath": "packages/ai/scripts/derive-astra-catalog.ts", "deriverSha256": digest(deriver),
            "publishedArchiveSha256": "d" * 64, "approvedArchiveSha256": "e" * 64,
            "inputProofSha256": "c" * 64, "derivationReportSha256": digest(json_bytes(self.report)),
            "outputManifestSha256": digest(catalog_manifest),
            "generatedAt": "2026-09-07T00:00:00.000Z", "providerFiles": 2,
            "byteIdenticalProviderFiles": 1, "semanticModelAdditions": 1,
            "verification": {
                "sourceClean": True, "committedSourceRepeatIdentical": True,
                "materializedBuildCatalogMatchesRepeat": True, "inputArchivesUnchanged": True,
                "sourceChecksPassed": True, "aiTestsPassed": 1, "coreTestsPassed": 1,
                "sdkTestsPassed": 1, "sdkTestsSkipped": 0, "offlineBuildPassed": True,
                "modularAndBundledWorktreeSmokesPassed": True,
            },
            "qualifications": ["Synthetic producer test; no deployment acceptance."],
        }
        self.save_proof()
        # Freeze the independent caller pin once, never derive it at invocation.
        self.proof_sha256 = digest(self.proof_path.read_bytes())

    def package(self, directory):
        return self.source / "packages" / directory

    def set_manifest(self, directory, value):
        put(self.package(directory) / "package.json", json_bytes(value))

    def save_proof(self):
        put(self.proof_path, json_bytes(self.proof))

    def command(self, *args, cwd):
        self.commands.append((args, Path(cwd)))
        if args == ("git", "rev-parse", "HEAD"):
            return self.revision
        if args == ("git", "status", "--porcelain", "--untracked-files=all"):
            return self.dirty
        if args[:4] != ("npm", "pack", "--ignore-scripts", "--json"):
            raise AssertionError(f"Unexpected command in synthetic fixture: {args}")
        if len(args) != 6 or args[4] != "--pack-destination":
            raise AssertionError("Pack must only target its fresh staging directory")
        directory = Path(cwd).name
        entries = {"package/" + path.relative_to(cwd).as_posix(): path.read_bytes()
                   for path in Path(cwd).rglob("*") if path.is_file()
                   and not path.relative_to(cwd).as_posix().startswith(("src/", "scripts/"))}
        if self.pack_mutator:
            self.pack_mutator(directory, entries)
        packed = Path(args[5]) / f"synthetic-{directory}.tgz"
        with tarfile.open(packed, "w:gz") as archive:
            for name in sorted(entries, reverse=self.pack_order_reverse):
                item = tarfile.TarInfo(name)
                body = entries[name]
                item.size = len(body)
                item.mode = 0o755 if name.endswith(("/cli.js", "/rpc-entry.js")) else 0o644
                if self.pack_member_mutator:
                    self.pack_member_mutator(directory, item)
                archive.addfile(item, io.BytesIO(body))
        payload = packed.read_bytes()
        record = {
            "filename": self.returned_filename or packed.name,
            "name": PACKAGE_NAMES[directory], "version": "0.85.0",
            "size": len(payload), "shasum": hashlib.sha1(payload).hexdigest(),
            "integrity": "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode(),
        }
        if self.record_mutator:
            self.record_mutator(record)
        return json.dumps(self.pack_output(PACKAGE_NAMES[directory], record))

    def run(self, with_proof=True, with_proof_hash=True):
        argv = ["vendor-pi-artifacts.py", "--source", str(self.source), "--output", str(self.output)]
        if with_proof:
            argv += ["--catalog-proof", str(self.proof_path)]
        if with_proof_hash:
            argv += ["--catalog-proof-sha256", self.proof_sha256]
        stdout = io.StringIO()
        make_temporary_directory = tempfile.mkdtemp
        def make_stage(**kwargs):
            # Failed production stages are retained, but test stages stay within
            # this fixture's owned temporary tree and its eventual cleanup.
            stage = make_temporary_directory(dir=self.source.parent, **kwargs)
            self.stages.append(Path(stage))
            return stage
        with patch.object(sys, "argv", argv), patch.object(vendor, "command", self.command), \
                patch.object(vendor.tempfile, "mkdtemp", side_effect=make_stage), \
                patch.object(vendor.subprocess, "run", side_effect=AssertionError("No live commands in tests")), \
                redirect_stdout(stdout):
            vendor.main()
        return json.loads(stdout.getvalue())


class IsolatedCommittedGit:
    """Real local Git semantics without ambient config, hooks, signing or identity."""
    def __init__(self, source):
        self.source = source.resolve()
        control = self.source.parent / "isolated-git-control"
        home = control / "home"
        xdg = control / "xdg"
        empty_hooks = control / "empty-hooks"
        empty_template = control / "empty-template"
        for path in (home, xdg, empty_hooks, empty_template):
            path.mkdir(parents=True)
        empty_config = control / "empty-config"
        empty_config.write_bytes(b"")
        binary = shutil.which("git")
        if binary is None:
            raise RuntimeError("Git is required for the committed-source regression fixture")
        self.binary = str(Path(binary).resolve())
        # Capture only this runner before TripletFixture.run blocks subprocess.run.
        # Its sole use is this argv-allowlisted Git fixture; npm stays synthetic.
        self.process = subprocess.run
        self.environment = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(home), "XDG_CONFIG_HOME": str(xdg), "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": str(empty_config),
            "GIT_CONFIG_GLOBAL": str(empty_config), "GIT_ATTR_NOSYSTEM": "1",
            "GIT_TEMPLATE_DIR": str(empty_template), "GIT_TERMINAL_PROMPT": "0",
            "GIT_CEILING_DIRECTORIES": str(self.source.parent),
            "GIT_AUTHOR_NAME": "Synthetic Pi Artifact Test",
            "GIT_AUTHOR_EMAIL": "pi-artifact-test@example.invalid",
            "GIT_COMMITTER_NAME": "Synthetic Pi Artifact Test",
            "GIT_COMMITTER_EMAIL": "pi-artifact-test@example.invalid",
            "GIT_AUTHOR_DATE": "2026-09-07T00:00:00+00:00",
            "GIT_COMMITTER_DATE": "2026-09-07T00:00:00+00:00",
        }
        self.config = [
            "-c", f"core.hooksPath={empty_hooks}",
            "-c", f"core.excludesFile={empty_config}",
            "-c", f"core.attributesFile={empty_config}",
            "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
            "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
            "-c", "credential.helper=", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
            "-c", "user.name=Synthetic Pi Artifact Test",
            "-c", "user.email=pi-artifact-test@example.invalid",
        ]
        put(self.source / ".gitignore", b"dist/\nnode_modules/\n")
        put(self.source / "packages/agent/src/index.ts", b"// committed synthetic source\n")
        self.run("init", "--quiet", "--object-format=sha1", "--template", str(empty_template))
        self.run("add", "--", ".")
        self.run("commit", "--quiet", "-m", "Synthetic producer fixture")
        self.revision = self.run("rev-parse", "HEAD")

    def run(self, *args):
        if not args or args[0] not in ("init", "add", "commit", "rev-parse", "status", "check-ignore"):
            raise AssertionError("Unexpected Git command in disposable repository fixture")
        result = self.process(
            [self.binary, *self.config, *args], cwd=self.source, env=self.environment,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=True, text=True, timeout=15,
        )
        return result.stdout.strip()

    def command(self, *args, cwd):
        if not args or args[0] != "git" or Path(cwd).resolve() != self.source:
            raise AssertionError("Real Git is confined to the disposable source fixture")
        return self.run(*args[1:])


class CommittedTripletFixture(TripletFixture):
    def __init__(self, root):
        super().__init__(root)
        self.git = IsolatedCommittedGit(self.source)
        self.revision = self.git.revision
        self.proof["sourceRevision"] = self.revision
        self.save_proof()
        self.proof_sha256 = digest(self.proof_path.read_bytes())

    def command(self, *args, cwd):
        if args and args[0] == "git":
            self.commands.append((args, Path(cwd)))
            # Forward production's exact status flags; never sanitize away the bug.
            return self.git.command(*args, cwd=cwd)
        return super().command(*args, cwd=cwd)


class SourceCleanlinessGitTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix="wayang-committed-source-test-")
        self.addCleanup(temporary.cleanup)
        return CommittedTripletFixture(Path(temporary.name))

    def test_source_identity_rejects_nonignored_untracked_source_in_committed_repository(self):
        fixture = self.fixture()
        with patch.object(vendor, "command", fixture.git.command):
            self.assertEqual(vendor.source_identity(fixture.source), fixture.revision)
            put(fixture.source / "packages/agent/src/untracked.ts", b"// unreviewed synthetic source\n")
            self.assertIn("?? packages/agent/src/untracked.ts",
                          fixture.git.run("status", "--porcelain", "--untracked-files=all"))
            with self.assertRaisesRegex(ValueError, "(?i)(source|clean|untracked)"):
                vendor.source_identity(fixture.source)

    def test_untracked_source_introduced_during_pack_prevents_triplet_publication(self):
        fixture = self.fixture()
        target = fixture.source / "packages/agent/src/untracked.ts"
        def introduce_untracked_source(directory, entries):
            if directory == "ai":
                put(target, b"// synthetic source introduced after initial cleanliness check\n")
        fixture.pack_mutator = introduce_untracked_source
        failure = None
        try:
            fixture.run()
        except ValueError as error:
            failure = error
        self.assertTrue(target.is_file(), "The mutation must actually happen during synthetic npm pack")
        self.assertFalse(list(fixture.output.glob("*.tgz")),
                         "Untracked source introduced during packing must prevent triplet publication")
        self.assertIsInstance(failure, ValueError)
        self.assertRegex(str(failure), "(?i)(source|clean|untracked)")
        self.assertTrue(fixture.stages and fixture.stages[0].is_dir(), "Retain the denied pack stage")

    def test_ignored_build_and_dependency_files_remain_allowed_in_committed_repository(self):
        fixture = self.fixture()
        build = "packages/agent/dist/synthetic-extra.js"
        dependency = "node_modules/synthetic-dependency/index.js"
        put(fixture.source / build, b"// ignored synthetic build output\n")
        put(fixture.source / dependency, b"// ignored synthetic dependency\n")
        self.assertEqual(set(fixture.git.run("check-ignore", "--", build, dependency).splitlines()),
                         {build, dependency})
        self.assertEqual(fixture.git.run("status", "--porcelain", "--untracked-files=all"), "")
        with patch.object(vendor, "command", fixture.git.command):
            self.assertEqual(vendor.source_identity(fixture.source), fixture.revision)
        result = fixture.run()
        self.assertEqual(result["sourceRevision"], fixture.revision)
        self.assertEqual(len(result["artifacts"]), 3)


class TripletArtifactTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix="wayang-triplet-test-")
        self.addCleanup(temporary.cleanup)
        return TripletFixture(Path(temporary.name))

    def assert_rejected(self, fixture, pattern):
        with self.assertRaisesRegex(ValueError, pattern):
            fixture.run()
        self.assertFalse(list(fixture.output.glob("*.tgz")), "Rejected input must not publish a partial triplet")

    def test_main_packs_exact_triplet_and_preserves_upstream_metadata_and_all_runtime_bytes(self):
        # Legacy one-element arrays remain supported.
        self.assert_exact_triplet(self.fixture())

    def test_main_accepts_package_keyed_npm_pack_object_with_exact_triplet_provenance(self):
        fixture = self.fixture()
        fixture.pack_output = lambda name, record: {name: record}
        self.assert_exact_triplet(fixture)

    def test_main_rejects_empty_multiple_mismatched_or_nonobject_npm_pack_records(self):
        outputs = {
            "empty-array": lambda name, record: [],
            "multiple-array": lambda name, record: [record, record],
            "empty-object": lambda name, record: {},
            "multiple-object": lambda name, record: {name: record, "@earendil-works/wrong": record},
            # The inner record is otherwise valid: the outer key must also bind identity.
            "mismatched-key": lambda name, record: {"@earendil-works/wrong": record},
            "bare-record": lambda name, record: record,
        }
        for value in (None, [], "invalid", 1, True):
            outputs[f"array-nonobject-{value!r}"] = lambda name, record, value=value: [value]
            outputs[f"keyed-nonobject-{value!r}"] = lambda name, record, value=value: {name: value}
            if not isinstance(value, list):
                outputs[f"top-level-nonobject-{value!r}"] = lambda name, record, value=value: value
        for label, output in outputs.items():
            with self.subTest(output=label):
                fixture = self.fixture()
                fixture.pack_output = output
                self.assert_rejected(fixture, "(?i)(npm pack|record|identity|key)")
                self.assertEqual(len([args for args, _ in fixture.commands if args[0] == "npm"]), 1)
                self.assertTrue(fixture.stages[0].is_dir(), "Retain malformed-output pack stages")

    def test_package_keyed_npm_pack_keeps_filename_identity_and_archive_integrity_gates(self):
        for field, value, pattern in (
            ("filename", "../outside.tgz", "(?i)(filename|basename|unsafe|path)"),
            ("name", "@earendil-works/wrong", "(?i)identity"),
            ("version", "0.84.1", "(?i)(identity|version)"),
            ("size", 1, "(?i)(size|integrity)"),
            ("size", True, "(?i)(size|integrity)"),
            ("integrity", "sha512-wrong", "(?i)integrity"),
            ("shasum", "0" * 40, "(?i)(integrity|hash|shasum)"),
        ):
            with self.subTest(field=field, value=value):
                fixture = self.fixture()
                # Keep the outer key correct even when the inner name is corrupted.
                fixture.pack_output = lambda name, record: {name: record}
                fixture.record_mutator = lambda record: record.update({field: value})
                self.assert_rejected(fixture, pattern)
        for change in ("missing", "changed", "unsafe"):
            with self.subTest(archive=change):
                fixture = self.fixture()
                fixture.pack_output = lambda name, record: {name: record}
                def mutate(directory, entries):
                    if change == "missing":
                        del entries["package/dist/index.js"]
                    elif change == "changed":
                        entries["package/dist/index.js"] = b"// not the source snapshot\n"
                    else:
                        entries["package/../outside"] = b"not extracted\n"
                # The fixture recomputes valid record hashes for these invalid archives.
                fixture.pack_mutator = mutate
                self.assert_rejected(fixture, "(?i)(snapshot|unsafe|path)")

    def assert_exact_triplet(self, fixture):
        result = fixture.run()
        self.assertEqual(result["sourceRevision"], REVISION)
        self.assertEqual(len(result["artifacts"]), 3)
        by_package = {}
        for record in result["artifacts"]:
            path = fixture.output / record["file"]
            payload = path.read_bytes()
            entries = archive_entries(path)
            manifest = json.loads(entries["package/package.json"])
            by_package[manifest["name"]] = record
            self.assertEqual(record["sha256"], digest(payload))
            self.assertEqual(record["integrity"], "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode())
            self.assertEqual(record["sizeBytes"], len(payload))
            self.assertEqual(manifest["wayangSourceRevision"], REVISION)
            self.assertEqual(manifest["wayangAiCatalogManifestSha256"], fixture.proof["outputManifestSha256"])
            directory = next(key for key, value in PACKAGE_NAMES.items() if value == manifest["name"])
            original = fixture.source_manifests[directory]
            for key, value in original.items():
                if key != "version":
                    self.assertEqual(manifest[key], value, f"Preserve {directory} {key}")
            for source_file in (fixture.package(directory) / "dist").rglob("*"):
                if source_file.is_file():
                    member = "package/" + source_file.relative_to(fixture.package(directory)).as_posix()
                    self.assertEqual(entries[member], source_file.read_bytes(), member)
            if directory == "ai":
                self.assertEqual(manifest["version"], "0.85.0")
                self.assertEqual(record["file"], f"earendil-works-pi-ai-0.85.0-wayang.{digest(payload)[:8]}.tgz")
                for field, expected in {
                    "wayangAiCatalogDerivationSha256": fixture.proof["derivationReportSha256"],
                    "wayangAiCatalogProvenanceSha256": fixture.proof_sha256,
                    "wayangAiPublishedArchiveSha256": fixture.proof["publishedArchiveSha256"],
                    "wayangAiApprovedArchiveSha256": fixture.proof["approvedArchiveSha256"],
                    "wayangAiDeriverSha256": fixture.proof["deriverSha256"],
                }.items():
                    self.assertEqual(manifest[field], expected)
                for name, body in fixture.catalog_files.items():
                    self.assertEqual(entries[f"package/dist/providers/data/{name}"], body)
            else:
                self.assertEqual(manifest["wayangRequiredAiSourceRevision"], REVISION)
                short_name = manifest["name"].split("/")[1]
                self.assertEqual(record["file"], f"earendil-works-{short_name}-0.85.0-wayang.aaaaaaaa.tgz")
                self.assertEqual(manifest["version"], "0.85.0-wayang.aaaaaaaa" if directory == "coding-agent" else "0.85.0")
            if directory == "coding-agent":
                self.assertEqual(manifest["wayangRequiredCoreSourceRevision"], REVISION)
                expected_lock = copy.deepcopy(fixture.lock)
                expected_lock["version"] = expected_lock["packages"][""]["version"] = "0.85.0-wayang.aaaaaaaa"
                self.assertEqual(json.loads(entries["package/npm-shrinkwrap.json"]), expected_lock)
                with tarfile.open(path, "r:gz") as archive:
                    self.assertTrue(archive.getmember("package/dist/bundle/cli.js").mode & 0o111)
        self.assertEqual(set(by_package), set(PACKAGE_NAMES.values()))
        packed = [cwd.name for args, cwd in fixture.commands if args[0] == "npm"]
        self.assertCountEqual(packed, PACKAGE_NAMES)

    def test_main_seals_upstream_0644_declared_bins_as_0755_without_changing_bytes_or_nonbins(self):
        fixture = self.fixture()
        fixture.pack_output = lambda name, record: {name: record}
        source_modes = {}
        for directory, manifest in fixture.source_manifests.items():
            for target in manifest.get("bin", {}).values():
                path = fixture.package(directory) / target
                put(path, b"#!/usr/bin/env node\n" + path.read_bytes())
                source_modes[path] = path.stat().st_mode
        raw_modes = {}
        def upstream_modes(directory, member):
            # Include one executable non-bin to retain the serializer's existing policy.
            member.mode = 0o755 if member.name == "package/README.md" else 0o644
            raw_modes[(directory, member.name)] = member.mode
        fixture.pack_member_mutator = upstream_modes
        self.assert_exact_triplet(fixture)
        for path in fixture.output.glob("*.tgz"):
            with tarfile.open(path, "r:gz") as archive:
                manifest = json.load(archive.extractfile("package/package.json"))
                directory = next(key for key, name in PACKAGE_NAMES.items() if name == manifest["name"])
                bins = {"package/" + target for target in manifest.get("bin", {}).values()}
                for member in archive.getmembers():
                    raw_mode = raw_modes[(directory, member.name)]
                    self.assertEqual(member.mode, 0o755 if member.name in bins else raw_mode, member.name)
                    if member.name in bins:
                        self.assertEqual(raw_mode, 0o644)
                        self.assertTrue(archive.extractfile(member).read().startswith(b"#!/usr/bin/env node\n"))
                    if member.name not in ("package/package.json", "package/npm-shrinkwrap.json"):
                        self.assertEqual(archive.extractfile(member).read(),
                                         (fixture.package(directory) / member.name[8:]).read_bytes(), member.name)
        for path, mode in source_modes.items():
            self.assertEqual(path.stat().st_mode, mode, "Sealing must not chmod the source")

    def test_0644_bin_normalization_still_rejects_missing_changed_or_linked_declared_bins(self):
        for directory, target in (("ai", "dist/cli.js"), ("coding-agent", "dist/bundle/cli.js")):
            for change in ("missing-source", "missing-archive", "changed-archive", "symlink", "hardlink"):
                with self.subTest(directory=directory, change=change):
                    fixture = self.fixture()
                    fixture.pack_output = lambda name, record: {name: record}
                    member_name = "package/" + target
                    def mutate_entries(selected, entries):
                        if selected == directory:
                            if change == "missing-archive":
                                del entries[member_name]
                            elif change == "changed-archive":
                                entries[member_name] = b"#!/usr/bin/env node\n// not snapshotted\n"
                    def mutate_member(selected, member):
                        if selected == directory and member.name == member_name:
                            member.mode = 0o644
                            if change in ("symlink", "hardlink"):
                                member.type = tarfile.SYMTYPE if change == "symlink" else tarfile.LNKTYPE
                                member.linkname = "package/dist/index.js"
                                member.size = 0
                    fixture.pack_mutator = mutate_entries
                    fixture.pack_member_mutator = mutate_member
                    if change == "missing-source":
                        (fixture.package(directory) / target).unlink()
                    self.assert_rejected(fixture, "(?i)(missing|snapshot|unsafe|entry)")

    def test_0644_bin_normalization_does_not_allow_unsafe_bin_declarations(self):
        for target in ("../outside.js", "/outside.js", "dist/../cli.js", "dist\\cli.js"):
            with self.subTest(target=target):
                fixture = self.fixture()
                manifest = copy.deepcopy(fixture.source_manifests["ai"])
                manifest["bin"] = {"pi-ai": target}
                fixture.set_manifest("ai", manifest)
                self.assert_rejected(fixture, "(?i)(unsafe|path)")
                self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))

    def test_repeat_bytes_are_independent_of_output_directory_and_input_member_order(self):
        fixture = self.fixture()
        first = fixture.run()
        payloads = {record["file"]: (fixture.output / record["file"]).read_bytes() for record in first["artifacts"]}
        self.assertEqual(fixture.run(), first)
        fixture.output = fixture.output.with_name("repeat-output")
        fixture.pack_order_reverse = True
        self.assertEqual(fixture.run(), first)
        self.assertEqual({name: (fixture.output / name).read_bytes() for name in payloads}, payloads)

    def test_rejects_missing_proof_instead_of_packing_an_unprovenanced_cohort(self):
        fixture = self.fixture()
        with self.assertRaises((ValueError, SystemExit)):
            fixture.run(with_proof=False)
        self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))

    def test_requires_independent_proof_hash_even_when_the_proof_path_is_valid(self):
        fixture = self.fixture()
        with self.assertRaises((ValueError, SystemExit)):
            fixture.run(with_proof_hash=False)
        self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))
        self.assertFalse(list(fixture.output.glob("*.tgz")))

    def test_rejects_wrong_or_malformed_independent_proof_hash_before_packing(self):
        for expected in ("0" * 64, "", "a" * 8, "A" * 64, "g" * 64):
            with self.subTest(expected=expected):
                fixture = self.fixture()
                fixture.proof_sha256 = expected
                self.assert_rejected(fixture, "(?i)(proof|provenance|sha256|hash|digest)")
                self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))

    def test_rejects_stale_or_wrong_path_proof_bytes_against_the_frozen_caller_hash(self):
        for change in ("whitespace", "valid-other-proof", "invalid-json", "wrong-path"):
            with self.subTest(change=change):
                fixture = self.fixture()
                original_pin = fixture.proof_sha256
                if change == "whitespace":
                    # Equivalent JSON is still not the independently reviewed bytes.
                    fixture.proof_path.write_bytes(fixture.proof_path.read_bytes() + b"\n")
                elif change == "invalid-json":
                    fixture.proof_path.write_bytes(b"not json")
                else:
                    if change == "wrong-path":
                        fixture.proof_path = fixture.catalog / "other-provenance.json"
                    fixture.proof["qualifications"] = ["Different synthetic proof; not independently reviewed."]
                    fixture.save_proof()
                self.assertEqual(fixture.proof_sha256, original_pin)
                # Hash verification precedes JSON parsing and npm invocation.
                self.assert_rejected(fixture, "(?i)(sha256|hash|digest)")
                self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))

    def test_source_revision_and_cleanliness_must_match_the_reviewed_proof(self):
        for field, value in (("revision", "b" * 40), ("revision", "a" * 8), ("dirty", " M packages/agent/src/index.ts")):
            with self.subTest(field=field, value=value):
                fixture = self.fixture()
                setattr(fixture, field, value)
                self.assert_rejected(fixture, "(?i)(source|revision|clean)")
                self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))

    def test_rejects_missing_wrong_or_unsupported_source_package_identities(self):
        for directory in PACKAGE_NAMES:
            for change in ("missing", "name", "version"):
                with self.subTest(directory=directory, change=change):
                    fixture = self.fixture()
                    manifest = copy.deepcopy(fixture.source_manifests[directory])
                    if change == "missing":
                        (fixture.package(directory) / "package.json").unlink()
                    else:
                        manifest[change] = "@earendil-works/wrong" if change == "name" else "0.86.0"
                        fixture.set_manifest(directory, manifest)
                    self.assert_rejected(fixture, "(?i)(package|identity|version|missing)")
                    self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))

    def test_rejects_unbound_catalog_proof_fields_and_failed_verification(self):
        for key in ("sourceRevision", "deriverSha256", "derivationReportSha256", "outputManifestSha256",
                    "publishedArchiveSha256", "approvedArchiveSha256", "inputProofSha256"):
            with self.subTest(key=key):
                fixture = self.fixture()
                fixture.proof[key] = "0" * (40 if key == "sourceRevision" else 64)
                fixture.save_proof()
                # Explicitly pin this invalid fixture to reach semantic validation.
                fixture.proof_sha256 = digest(fixture.proof_path.read_bytes())
                self.assert_rejected(fixture, "(?i)(proof|provenance|catalog|revision|deriv|hash|archive)")
        for key in ("sourceClean", "committedSourceRepeatIdentical", "materializedBuildCatalogMatchesRepeat",
                    "inputArchivesUnchanged", "sourceChecksPassed", "offlineBuildPassed",
                    "modularAndBundledWorktreeSmokesPassed"):
            with self.subTest(verification=key):
                fixture = self.fixture()
                fixture.proof["verification"][key] = False
                fixture.save_proof()
                # A matching caller pin cannot bless failed verification evidence.
                fixture.proof_sha256 = digest(fixture.proof_path.read_bytes())
                self.assert_rejected(fixture, "(?i)(proof|provenance|verif|check|build|clean)")

    def test_rejects_changed_missing_or_extra_catalog_bytes_in_every_input_tree(self):
        for tree in ("proof", "src", "dist"):
            for change in ("changed", "missing", "extra"):
                with self.subTest(tree=tree, change=change):
                    fixture = self.fixture()
                    data = fixture.catalog / "data" if tree == "proof" else fixture.package("ai") / tree / "providers/data"
                    target = data / "openai.json"
                    if change == "missing":
                        target.unlink()
                    elif change == "extra":
                        put(data / "extra.json", b"{}\n")
                    else:
                        put(target, b"{}\n")
                    self.assert_rejected(fixture, "(?i)(catalog|manifest|provider|hash|missing)")

    def test_requires_valid_sdk_shrinkwrap_and_root_identity_without_dropping_dependency_graph(self):
        for change in ("missing", "invalid-json", "name", "version", "root-name", "root-version", "missing-root"):
            with self.subTest(change=change):
                fixture = self.fixture()
                target = fixture.package("coding-agent") / "npm-shrinkwrap.json"
                lock = copy.deepcopy(fixture.lock)
                if change == "missing":
                    target.unlink()
                elif change == "invalid-json":
                    target.write_bytes(b"not json")
                else:
                    if change == "missing-root":
                        del lock["packages"][""]
                    elif change.startswith("root-"):
                        lock["packages"][""][change[5:]] = "wrong"
                    else:
                        lock[change] = "wrong"
                    put(target, json_bytes(lock))
                self.assert_rejected(fixture, "(?i)(shrinkwrap|lock|identity|version|json)")

    def test_omitted_sdk_shrinkwrap_maps_validated_source_to_identical_sealed_bytes(self):
        fixture = self.fixture()
        fixture.pack_output = lambda name, record: {name: record}
        target = fixture.package("coding-agent") / "npm-shrinkwrap.json"
        source_body, source_mode = target.read_bytes(), target.stat().st_mode
        # The included-lock baseline checks the entire graph and only the two version rewrites.
        self.assert_exact_triplet(fixture)
        included = {path.name: path.read_bytes() for path in fixture.output.glob("*.tgz")}
        fixture.output = fixture.output.with_name("omitted-lock-output")
        fixture.commands.clear()
        def omit_lock(directory, entries):
            if directory == "coding-agent":
                del entries["package/npm-shrinkwrap.json"]
        fixture.pack_mutator = omit_lock
        with patch.object(vendor, "triplet_payload", wraps=vendor.triplet_payload) as seal:
            self.assert_exact_triplet(fixture)
        sdk_call = next(call for call in seal.call_args_list if call.args[1] == "coding-agent")
        self.assertEqual(sdk_call.args[0]["npm-shrinkwrap.json"], (source_body, 0o644),
                         "Supplement the exact validated source bytes before version rewriting")
        self.assertEqual({path.name: path.read_bytes() for path in fixture.output.glob("*.tgz")}, included)
        sdk = fixture.output / "earendil-works-pi-coding-agent-0.85.0-wayang.aaaaaaaa.tgz"
        with tarfile.open(sdk, "r:gz") as archive:
            self.assertEqual(archive.getmember("package/npm-shrinkwrap.json").mode, 0o644)
        self.assertEqual(target.read_bytes(), source_body)
        self.assertEqual(target.stat().st_mode, source_mode)

    def test_omitted_sdk_shrinkwrap_rejects_source_drift_missing_or_links_after_snapshot(self):
        for change in ("drift", "whitespace", "missing", "symlink", "hardlink"):
            with self.subTest(change=change):
                fixture = self.fixture()
                target = fixture.package("coding-agent") / "npm-shrinkwrap.json"
                original = target.read_bytes()
                def omit_and_change_source(directory, entries):
                    if directory != "coding-agent":
                        return
                    del entries["package/npm-shrinkwrap.json"]
                    if change == "drift":
                        # Same-sized valid graph with different bytes must not acquire the old snapshot.
                        target.write_bytes(original.replace(b"pi-ai.tgz", b"pi-xx.tgz"))
                    elif change == "whitespace":
                        target.write_bytes(original + b"\n")
                    else:
                        target.unlink()
                        if change in ("symlink", "hardlink"):
                            other = fixture.source.parent / "synthetic-lock-copy.json"
                            other.write_bytes(original)
                            if change == "symlink":
                                target.symlink_to(other)
                            else:
                                os.link(other, target)
                fixture.pack_mutator = omit_and_change_source
                self.assert_rejected(fixture, "(?i)(shrinkwrap|lock)")
                self.assertTrue(fixture.stages[0].is_dir())

    def test_supplied_invalid_sdk_shrinkwrap_is_never_replaced_with_source_lock(self):
        for change in ("invalid-json", "drift", "symlink", "hardlink"):
            with self.subTest(change=change):
                fixture = self.fixture()
                def mutate_entries(directory, entries):
                    if directory == "coding-agent":
                        if change == "invalid-json":
                            entries["package/npm-shrinkwrap.json"] = b"not json\n"
                        elif change == "drift":
                            entries["package/npm-shrinkwrap.json"] = entries["package/npm-shrinkwrap.json"].replace(
                                b"pi-ai.tgz", b"pi-xx.tgz")
                def mutate_member(directory, member):
                    if (directory == "coding-agent" and member.name == "package/npm-shrinkwrap.json"
                            and change in ("symlink", "hardlink")):
                        member.type = tarfile.SYMTYPE if change == "symlink" else tarfile.LNKTYPE
                        member.linkname = "package/package.json"
                        member.size = 0
                fixture.pack_mutator = mutate_entries
                fixture.pack_member_mutator = mutate_member
                self.assert_rejected(fixture, "(?i)(snapshot|unsafe)")

    def test_omitted_sdk_shrinkwrap_does_not_excuse_other_missing_required_members(self):
        for member in ("package/dist/bundle/cli.js", "package/dist/bundle/chunks/openai-codex.js",
                       "package/dist/modes/interactive/assets/pi.png", "package/package.json"):
            with self.subTest(member=member):
                fixture = self.fixture()
                def omit(directory, entries):
                    if directory == "coding-agent":
                        del entries["package/npm-shrinkwrap.json"]
                        del entries[member]
                fixture.pack_mutator = omit
                self.assert_rejected(fixture, "(?i)(omitted|missing).*snapshot")

    def test_omitted_sdk_shrinkwrap_is_not_read_before_raw_integrity_and_supplied_member_checks(self):
        for change in ("integrity", "changed-member", "extra-member", "unsafe-member"):
            with self.subTest(change=change):
                fixture = self.fixture()
                target = fixture.package("coding-agent") / "npm-shrinkwrap.json"
                packing_sdk = False
                supplemental_reads = []
                regular_bytes = vendor.regular_bytes
                def observe_read(path, *args, **kwargs):
                    if packing_sdk and Path(path) == target:
                        supplemental_reads.append(path)
                    return regular_bytes(path, *args, **kwargs)
                def omit_and_corrupt(directory, entries):
                    nonlocal packing_sdk
                    if directory != "coding-agent":
                        return
                    packing_sdk = True
                    del entries["package/npm-shrinkwrap.json"]
                    if change == "changed-member":
                        entries["package/dist/index.js"] = b"// changed\n"
                    elif change == "extra-member":
                        entries["package/dist/unreviewed.js"] = b"// extra\n"
                    elif change == "unsafe-member":
                        entries["package/../outside"] = b"not extracted\n"
                def corrupt_record(record):
                    if record["name"] == PACKAGE_NAMES["coding-agent"] and change == "integrity":
                        record["integrity"] = "sha512-wrong"
                fixture.pack_mutator = omit_and_corrupt
                fixture.record_mutator = corrupt_record
                pattern = "(?i)integrity" if change == "integrity" else "(?i)(snapshot|unsafe|path)"
                with patch.object(vendor, "regular_bytes", side_effect=observe_read):
                    self.assert_rejected(fixture, pattern)
                self.assertTrue(packing_sdk)
                self.assertEqual(supplemental_reads, [], "Reject supplied bytes before reading the omitted lock")

    def test_requires_modular_bundled_lazy_and_asset_files_before_npm_pack(self):
        required = [(directory, "dist/index.js") for directory in PACKAGE_NAMES]
        required += [("coding-agent", name) for name in (
            "dist/index.d.ts", "dist/experimental/plugin.js", "dist/experimental/plugin.d.ts",
            "dist/bundle/cli.js", "dist/bundle/rpc-entry.js",
            "dist/bundle/index.js", "dist/bundle/client.js", "dist/bundle/coordinator.js",
            "dist/bundle/chunks/chunk-SYNTHETIC.js", "dist/modes/interactive/theme/dark.json",
            "dist/modes/interactive/assets/pi.png", "dist/core/export-html/template.html",
            "dist/core/export-html/template.css", "dist/core/export-html/template.js",
            "dist/core/export-html/vendor/marked.js",
        )]
        required += [("coding-agent", f"dist/bundle/chunks/{name}.js") for name in LAZY_NAMES]
        for directory, filename in required:
            with self.subTest(directory=directory, filename=filename):
                fixture = self.fixture()
                (fixture.package(directory) / filename).unlink()
                self.assert_rejected(fixture, "(?i)(missing|build|entry|asset|chunk|bundle|runtime)")
                self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))

    def test_rejects_wrong_unsafe_or_missing_declared_runtime_entries_without_modular_fallback(self):
        for field, value in (
            ("bin", {"pi": "dist/cli.js"}),
            ("bin", {"pi": "../outside.js"}),
            ("bin", {"pi": "/absolute.js"}),
            ("main", "./dist/missing.js"),
            ("types", "./dist/missing.d.ts"),
            ("exports", {".": {"import": "./dist/index.js"}, "./rpc-entry": {"import": "./dist/rpc-entry.js"}}),
        ):
            with self.subTest(field=field, value=value):
                fixture = self.fixture()
                manifest = copy.deepcopy(fixture.source_manifests["coding-agent"])
                manifest[field] = value
                fixture.set_manifest("coding-agent", manifest)
                self.assert_rejected(fixture, "(?i)(entry|bin|export|bundle|missing|target|path)")

    def test_wildcard_exports_require_every_matching_runtime_and_type_target(self):
        for missing in (None, "one.js", "one.d.ts"):
            with self.subTest(missing=missing):
                fixture = self.fixture()
                manifest = copy.deepcopy(fixture.source_manifests["ai"])
                manifest["exports"]["./providers/*"] = {
                    "import": "./dist/providers/*.js", "types": "./dist/providers/*.d.ts",
                }
                fixture.set_manifest("ai", manifest)
                for name in ("one.js", "one.d.ts", "two.js", "two.d.ts"):
                    if name != missing:
                        put(fixture.package("ai") / "dist/providers" / name, b"// synthetic wildcard target\n")
                if missing is None:
                    self.assertEqual(len(fixture.run()["artifacts"]), 3)
                else:
                    self.assert_rejected(fixture, "(?i)(wildcard|runtime|type|entry|target)")
                    self.assertFalse(any(args[0] == "npm" for args, _ in fixture.commands))

    def test_pack_members_must_equal_the_prepack_snapshot_not_just_contain_entry_names(self):
        for directory, member in (
            ("ai", "package/dist/providers/data/openai.json"),
            ("agent", "package/dist/index.js"),
            ("coding-agent", "package/dist/bundle/chunks/openai-codex.js"),
            ("coding-agent", "package/dist/modes/interactive/assets/pi.png"),
            ("coding-agent", "package/npm-shrinkwrap.json"),
            ("coding-agent", "package/package.json"),
        ):
            for change in ("missing", "changed"):
                with self.subTest(directory=directory, member=member, change=change):
                    fixture = self.fixture()
                    def mutate(selected, entries):
                        if selected == directory:
                            if change == "missing":
                                del entries[member]
                            else:
                                entries[member] = b"{}\n"
                    fixture.pack_mutator = mutate
                    if member == "package/npm-shrinkwrap.json" and change == "missing":
                        # Only archive omission is recoverable from the previously validated source lock.
                        # Missing/invalid source locks and supplied changed locks still fail closed.
                        self.assert_exact_triplet(fixture)
                    else:
                        self.assert_rejected(fixture, "(?i)(snapshot|pack|missing|changed|identity|hash|catalog|shrinkwrap)")

    def test_rejects_pack_filename_escape_before_opening_any_outside_archive(self):
        for filename in ("../outside.tgz", "/outside.tgz", "subdir/archive.tgz", "..\\outside.tgz"):
            with self.subTest(filename=filename):
                fixture = self.fixture()
                fixture.returned_filename = filename
                self.assert_rejected(fixture, "(?i)(filename|basename|unsafe|path)")

    def test_npm_record_identity_size_and_integrity_must_match_actual_archive(self):
        for field, value in (("name", "@earendil-works/wrong"), ("version", "0.84.1"),
                             ("size", 1), ("integrity", "sha512-wrong")):
            with self.subTest(field=field):
                fixture = self.fixture()
                fixture.record_mutator = lambda record: record.update({field: value})
                self.assert_rejected(fixture, "(?i)(pack|identity|version|size|integrity|hash)")

    def test_source_dist_drift_during_pack_does_not_acquire_old_source_provenance(self):
        fixture = self.fixture()
        def mutate(directory, entries):
            target = fixture.package("agent") / "dist/index.js"
            target.write_bytes(b"// changed while npm packs\n")
            if directory == "agent":
                entries["package/dist/index.js"] = target.read_bytes()
        fixture.pack_mutator = mutate
        self.assert_rejected(fixture, "(?i)(snapshot|changed|source|hash|pack)")

    def test_failed_pack_stage_is_retained_and_successful_stage_alone_is_removed(self):
        failed = self.fixture()
        failed.record_mutator = lambda record: record.update({"integrity": "sha512-wrong"})
        self.assert_rejected(failed, "(?i)integrity")
        self.assertEqual(len(failed.stages), 1)
        self.assertTrue(failed.stages[0].is_dir())
        self.assertTrue(list(failed.stages[0].glob("*.tgz")), "Retain the failed npm bytes for review")
        successful = self.fixture()
        successful.run()
        self.assertEqual(len(successful.stages), 1)
        self.assertFalse(successful.stages[0].exists())
        self.assertTrue(failed.stages[0].is_dir(), "Never clean up another run's failed stage")

    def test_bounded_reads_and_decompression_fail_before_unbounded_expansion(self):
        fixture = self.fixture()
        path = fixture.source.parent / "oversized-synthetic-file"
        path.write_bytes(b"123456789")
        with self.assertRaisesRegex(ValueError, "(?i)(oversized|limit|bound)"):
            vendor.regular_bytes(path, 8)
        payload = gzip.compress(b"x" * 8192, mtime=0)
        with patch.object(vendor, "MAX_PACKAGE_BYTES", 2048):
            with self.assertRaisesRegex(ValueError, "(?i)(decompression|limit|bound)"):
                vendor.bounded_archive(payload)

    def test_bounded_archive_rejects_links_duplicate_members_and_member_limits(self):
        for change in ("symlink", "hardlink", "duplicate", "case-collision", "entry-limit", "file-limit"):
            with self.subTest(change=change):
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode="w:gz") as archive:
                    for index in range(2):
                        name = "package/one.js" if index == 0 or change == "duplicate" else "package/two.js"
                        if index == 1 and change == "case-collision":
                            name = "package/ONE.js"
                        member = tarfile.TarInfo(name)
                        if index == 1 and change in ("symlink", "hardlink"):
                            member.type = tarfile.SYMTYPE if change == "symlink" else tarfile.LNKTYPE
                            member.linkname = "package/one.js"
                            archive.addfile(member)
                        else:
                            member.size = 3
                            archive.addfile(member, io.BytesIO(b"abc"))
                with patch.object(vendor, "MAX_ENTRIES", 1 if change == "entry-limit" else 10000), \
                        patch.object(vendor, "MAX_FILE_BYTES", 2 if change == "file-limit" else 1024):
                    with self.assertRaisesRegex(ValueError, "(?i)(unsafe|duplicate|oversized|limit)"):
                        vendor.bounded_archive(output.getvalue())

    def test_existing_artifacts_are_immutable_and_symlink_destinations_are_not_followed(self):
        for change in ("different-bytes", "symlink", "directory"):
            with self.subTest(change=change):
                fixture = self.fixture()
                fixture.output.mkdir()
                target = fixture.output / "earendil-works-pi-coding-agent-0.85.0-wayang.aaaaaaaa.tgz"
                sentinel = fixture.source.parent / "sentinel"
                sentinel.write_bytes(b"do not overwrite\n")
                if change == "different-bytes":
                    target.write_bytes(b"existing artifact\n")
                elif change == "symlink":
                    target.symlink_to(sentinel)
                else:
                    target.mkdir()
                before = set(fixture.output.iterdir())
                with self.assertRaisesRegex(ValueError, "(?i)(destination|overwrite|symlink|regular|artifact)"):
                    fixture.run()
                self.assertEqual(set(fixture.output.iterdir()), before, "Check all destinations before publishing any artifact")
                self.assertEqual(sentinel.read_bytes(), b"do not overwrite\n")
                if change == "different-bytes":
                    self.assertEqual(target.read_bytes(), b"existing artifact\n")
                elif change == "symlink":
                    self.assertTrue(target.is_symlink())
                else:
                    self.assertTrue(target.is_dir())


if __name__ == "__main__":
    unittest.main()
