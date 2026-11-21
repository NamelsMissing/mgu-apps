"""Offline tests for SDK packaging of the optional WheelHeat start type."""

import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "build_wheelheat_autostart.py"
LOADER = importlib.util.spec_from_file_location("wheelheat_autostart_builder", SCRIPT)
builder = importlib.util.module_from_spec(LOADER)
LOADER.loader.exec_module(builder)


class AutostartPackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="g21-autostart-test-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        app = self.repo / "apps" / "g21_wheelheat"
        app.mkdir(parents=True)
        (app / "app.json").write_text(json.dumps({"id": "g21_wheelheat", "version": "0.4.1",
                                                   "mguAppStartType": "autostart"}), encoding="utf-8")
        self.stage = self.repo / "dist" / "g21_wheelheat"
        src = self.stage / "source"
        src.mkdir(parents=True)
        (src / "package.json").write_text(json.dumps({"name": "g21_wheelheat", "version": "0.4.1"}),
                                           encoding="utf-8")
        (self.stage / "meta.json").write_text('{"kit":1}', encoding="utf-8")
        (src / "javascript").mkdir()
        (src / "javascript" / "app.js").write_text("// safe preview only\n", encoding="utf-8")
        (self.stage / "rhmiData").mkdir()
        (self.stage / "rhmiData" / "application.json").write_text("{}", encoding="utf-8")
        dist = self.repo / "dist"
        self.npm = dist / "g21_wheelheat@0.4.1.tgz"
        self.mgu = dist / "g21_wheelheat@0.4.1.mgu"
        for result, members in ((self.npm, (("source", "package"),)),
                                (self.mgu, (("meta.json", "meta.json"), ("source", "source"),
                                            ("rhmiData", "rhmiData")))):
            temporary = builder._create_archive(self.stage, result, members)
            temporary.replace(result)
        self.unrelated = dist / "g21_ambient@0.3.3.tgz"
        self.unrelated.write_bytes(b"unrelated ambient build")

    def check_package(self, result, member, wanted):
        with tarfile.open(result, "r:gz") as tgz:
            pkg = json.load(tgz.extractfile(member))
        self.assertEqual(pkg["mguAppStartType"], wanted)
        self.assertEqual(pkg["name"], "g21_wheelheat")

    def test_autostart_is_in_both_sdk_archives(self):
        builder.patch_artifacts(self.repo)
        self.check_package(self.npm, "package/package.json", "autostart")
        self.check_package(self.mgu, "source/package.json", "autostart")
        self.assertEqual(self.unrelated.read_bytes(), b"unrelated ambient build")

    def test_manual_start_is_reversible_for_offline_testing(self):
        builder.patch_artifacts(self.repo, "manually")
        self.check_package(self.npm, "package/package.json", "manually")
        builder.patch_artifacts(self.repo, "autostart")
        self.check_package(self.mgu, "source/package.json", "autostart")

    def check_app_autostart_is_scoped(self, app_id, version):
        app = self.repo / "apps" / app_id
        app.mkdir(parents=True)
        (app / "app.json").write_text(json.dumps({"id": app_id, "version": version,
                                                  "mguAppStartType": "autostart"}))
        stage = self.repo / "dist" / app_id
        (stage / "source").mkdir(parents=True)
        (stage / "source" / "package.json").write_text(json.dumps({"name": app_id, "version": version}))
        (stage / "meta.json").write_text("{}")
        npm = self.repo / "dist" / (app_id + "@" + version + ".tgz")
        mgu = self.repo / "dist" / (app_id + "@" + version + ".mgu")
        for out, roots in ((npm, (("source", "package"),)),
                           (mgu, (("source", "source"), ("meta.json", "meta.json")))):
            builder._create_archive(stage, out, roots).replace(out)
        old_heat = self.npm.read_bytes()
        builder.patch_artifacts(self.repo, "autostart", app_id=app_id)
        for out, member in ((npm, "package/package.json"), (mgu, "source/package.json")):
            with tarfile.open(out, "r:gz") as archive:
                pkg = json.load(archive.extractfile(member))
                self.assertEqual(pkg["name"], app_id)
                self.assertEqual(pkg["mguAppStartType"], "autostart")
        self.assertEqual(old_heat, self.npm.read_bytes())
        with self.assertRaises(builder.BuildError):
            builder.patch_artifacts(self.repo, "autostart", app_id="other")

    def test_app_autostart_is_scoped(self):
        for app_id in ("light_flasher", "blitzer_status"):
            with self.subTest(app_id=app_id):
                spec_dir = SCRIPT.parents[1] / "apps" / app_id
                version = builder._read_json(spec_dir / "app.json")["version"]
                self.check_app_autostart_is_scoped(app_id, version)

    def test_wrong_version_fails_before_overwriting_archives(self):
        old_tar = self.npm.read_bytes()
        pkg = self.stage / "source" / "package.json"
        pkg.write_text('{"name":"g21_wheelheat","version":"0.3.3"}', encoding="utf-8")
        with self.assertRaises(builder.BuildError):
            builder.patch_artifacts(self.repo)
        self.assertEqual(self.npm.read_bytes(), old_tar)


if __name__ == "__main__":
    unittest.main()
