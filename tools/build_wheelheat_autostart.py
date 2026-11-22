#!/usr/bin/env python3
"""Build WheelHeat with the MGU Store's supported app autostart setting.

The public idrive7-apps kit/tools/build.py does not copy mguAppStartType from
app.json to package.json. This wrapper runs it, then updates WheelHeat's
staged package metadata and repacks its SDK-generated archives. No SDK code,
system partition or installed head-unit component is modified.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile


APP_ID = "g21_wheelheat"
AUTOSTART_APPS = (APP_ID, "light_flasher", "custom_cluster", "cluster_lyrics")
START_TYPES = ("autostart", "manually")
MGU_MEMBERS = ("meta.json", "source", "rhmiData", "rhmiDataStartWidget", "oapgen")


class BuildError(RuntimeError):
    pass


def _read_json(path):
    if not path.is_file():
        raise BuildError("Missing file: " + str(path))
    return json.loads(path.read_text(encoding="utf-8"))


def _create_archive(directory, output_path, roots):
    with tempfile.NamedTemporaryFile(dir=output_path.parent,
                                     prefix=output_path.name + ".", suffix=".tmp",
                                     delete=False) as file:
        temporary = Path(file.name)
    try:
        with tarfile.open(temporary, "w:gz") as archive:
            for local_name, archive_name in roots:
                source = directory / local_name
                if source.exists():
                    archive.add(source, arcname=archive_name)
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _check_archive(archive_path, member, start_type, app_id=APP_ID):
    with tarfile.open(archive_path, "r:gz") as archive:
        package_file = archive.extractfile(member)
        if not package_file:
            raise BuildError(str(archive_path) + " has no " + member)
        package = json.load(package_file)
        if package.get("name") != app_id or package.get("mguAppStartType") != start_type:
            raise BuildError(str(archive_path) + " lacks requested app start type")


def patch_artifacts(repo_root, start_type="autostart", app_id=APP_ID):
    if app_id not in AUTOSTART_APPS:
        raise BuildError("Unsupported autostart app: " + str(app_id))
    if start_type not in START_TYPES:
        raise BuildError("Unknown start type: " + str(start_type))
    spec = _read_json(repo_root / "apps" / app_id / "app.json")
    if spec.get("id") != app_id or spec.get("mguAppStartType") not in START_TYPES:
        raise BuildError("App manifest has no supported app start type")
    version = spec["version"]
    if not isinstance(version, str) or version.count(".") != 2:
        raise BuildError("Invalid version in WheelHeat manifest")

    dist = repo_root / "dist"
    stage = dist / app_id
    package_path = stage / "source" / "package.json"
    package = _read_json(package_path)
    if package.get("name") != app_id or package.get("version") != version:
        raise BuildError("Staged app/version mismatch; rebuild using your SDK")
    package["mguAppStartType"] = start_type

    npm = dist / (app_id + "@" + version + ".tgz")
    mgu = dist / (app_id + "@" + version + ".mgu")
    if not npm.is_file() or not mgu.is_file() or not (stage / "meta.json").is_file():
        raise BuildError("Expected SDK .tgz, .mgu and meta.json are missing")

    package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    pending = []
    try:
        pending.append((_create_archive(stage, npm, (("source", "package"),)), npm,
                        "package/package.json"))
        pending.append((_create_archive(stage, mgu, ((n, n) for n in MGU_MEMBERS)), mgu,
                        "source/package.json"))
        for temporary, _output, member in pending:
            _check_archive(temporary, member, start_type, app_id)
        for temporary, output, _member in pending:
            os.replace(temporary, output)
    finally:
        for temporary, _output, _member in pending:
            temporary.unlink(missing_ok=True)
    return npm, mgu


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build WheelHeat with a verified startup mode")
    parser.add_argument("--sdk-root", type=Path, default=Path.cwd(),
                        help="Root of your idrive7-apps repository")
    parser.add_argument("--start-type", choices=START_TYPES, default=None,
                        help="override app.json start mode (default: use manifest)")
    parser.add_argument("--patch-only", action="store_true",
                        help="Update already-built SDK files without rerunning build.py")
    args = parser.parse_args(argv)
    repo_root = args.sdk_root.resolve()
    try:
        if not args.patch_only:
            builder = repo_root / "kit" / "tools" / "build.py"
            if not builder.is_file():
                raise BuildError("SDK builder not found: " + str(builder))
            subprocess.run([sys.executable, str(builder), APP_ID], cwd=repo_root, check=True)
        start_type = args.start_type or _read_json(repo_root / "apps" / APP_ID / "app.json").get("mguAppStartType")
        npm, mgu = patch_artifacts(repo_root, start_type)
    except (BuildError, OSError, subprocess.CalledProcessError, ValueError) as error:
        print("WheelHeat build failed: " + str(error), file=sys.stderr)
        return 1
    print("Start type: " + start_type)
    print("Verified: " + str(npm))
    print("Verified: " + str(mgu))
    print("Actual boot startup requires a compatible mgu-deploy installation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
