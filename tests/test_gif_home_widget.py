"""Regression checks for the Store-installable GIF Home start-widget bundle."""

import importlib.util
import base64
import json
from pathlib import Path
import tempfile
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "tools" / "build_gif_home.py"
module_spec = importlib.util.spec_from_file_location("gif_home_build", WRAPPER)
builder = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(builder)


class GifHomeWidgetTests(unittest.TestCase):
    def test_widget_is_packaged_for_store_and_native_installer(self):
        with tempfile.TemporaryDirectory(prefix="gif-home-widget-") as d:
            stage = Path(d)
            native = stage / "rhmiDataStartWidget"
            for name in ("uiDescription", "strings", "resources"):
                (native / name).mkdir(parents=True)
            example = {"schemaVersion": "1.3.0", "application": {
                "uuid": "example-widget-uuid", "type": "StartWidget", "name": "gif_home_widget",
                "vendor": "custom", "version": "1.0", "defaultLanguage": "en_GB",
                "stringBundleUuid": "example-strings", "resourceBundleUuid": "example-resources",
                "entryPoints": [],
            }}
            (native / "application.json").write_text(json.dumps(example), encoding="utf-8")
            (native / "uiDescription" / "application.xml").write_text("<application/>", encoding="utf-8")
            (native / "uiDescription" / "uiDescription.json").write_text("{}", encoding="utf-8")
            (native / "strings" / "de_DE.json").write_text("{}", encoding="utf-8")
            (native / "resources" / "gif_home_widget_icon.png").write_bytes(b"test-icon")

            package = builder.package_widget(stage)
            package_app = json.loads((package / "application.json").read_text(encoding="utf-8"))
            self.assertEqual(package_app["application"]["type"], "StartWidget")
            self.assertEqual(package_app["application"]["uiDescriptions"][0]["hmi"], ["ID7"])
            self.assertTrue((package / "uiDescriptions" / "ID7" / "uiDescription.json").is_file())
            self.assertTrue((package / "variantGroups" / "Common" / "texts" / "de_DE.json").is_file())
            self.assertEqual((package / "variantGroups" / "Common" / "images" /
                              "gif_home_widget_icon.png").read_bytes(), b"test-icon")

    def test_generated_widget_uses_existing_bmw_cell_and_store_dependency(self):
        sys.path.insert(0, str(ROOT / "kit" / "tools"))
        try:
            import build
        finally:
            sys.path.pop(0)
        app = json.loads((ROOT / "apps" / "gif_home" / "app.json").read_text(encoding="utf-8"))
        catalog = json.loads((ROOT / "mgu-repo.json").read_text(encoding="utf-8"))
        components = {entry["id"]: entry for entry in catalog["components"]}
        helper_path = ROOT / components["mgu-gif-net"]["path"]
        helper = json.loads((helper_path / "component.json").read_text(encoding="utf-8"))
        self.assertEqual(app["version"], components["gif_home"]["version"])
        self.assertEqual(components["gif_home"]["requires"][helper["id"]], helper["version"])
        for entry in helper["files"]:
            self.assertTrue((helper_path / entry["path"]).is_file())
        for entry in helper["units"]:
            content = (helper_path / entry["from"]).read_text(encoding="utf-8")
            self.assertIn("/var/opt/mgu-gif-net/current/", content)
        with tempfile.TemporaryDirectory(prefix="gif-home-id7-") as d:
            stage = Path(d)
            icon = stage / "icon.png"
            icon.write_bytes(b"test-icon")
            result = build.build_start_widget(app, app["id"], str(icon), str(stage / "rhmiDataStartWidget"))
            self.assertEqual(result, {"component": "GIF_HOME_WIDGET",
                                      "layout": "LT_Table_OnlineApps_DriveRecorderWidget"})
            self.assertEqual(app["startWidget"]["image"], "BackgroundImage1")
            self.assertEqual(app["startWidget"]["cells"]["background"], [False, "Bool"])
            self.assertTrue((builder.package_widget(stage) / "uiDescriptions" / "ID7" / "application.xml").exists())

    def test_standard_gif_resource_is_included(self):
        data = json.loads((ROOT / "apps" / "gif_home" / "resources" / "demo.json").read_text(encoding="utf-8"))
        gif = base64.b64decode(data["base64"], validate=True)
        self.assertTrue(gif.startswith(b"GIF89a") or gif.startswith(b"GIF87a"))
        self.assertLessEqual(len(gif), 6 * 1024 * 1024)

    def test_pixel_art_presets_are_individually_packaged(self):
        from PIL import Image
        from io import BytesIO

        app = json.loads((ROOT / "apps" / "gif_home" / "app.json").read_text(encoding="utf-8"))
        sources = dict(app["settings"][1]["options"])
        for name, file_name in (("drift", "drift_city"), ("sunset", "sunset_drive"),
                                ("garage", "garage_nights"), ("tunnel", "tunnel_run")):
            with self.subTest(name=name):
                self.assertIn(name, sources)
                data = json.loads((ROOT / "apps" / "gif_home" / "resources" /
                                   f"{file_name}.json").read_text(encoding="utf-8"))
                raw = base64.b64decode(data["base64"], validate=True)
                self.assertLessEqual(len(raw), 6 * 1024 * 1024)
                gif = Image.open(BytesIO(raw))
                self.assertEqual(gif.size, (192, 128))
                self.assertEqual(gif.n_frames, 18)


if __name__ == "__main__":
    unittest.main()
