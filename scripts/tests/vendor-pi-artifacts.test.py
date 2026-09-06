import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
