"""Fixed stdio entrypoint: use package server, NOT CLI background warmers.

Package 0.12.0 server.build_server and mcp.run are the installed package APIs.
Import/register/list has no data_version/query invocation. No shell dispatch.
"""
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys


def verify_install():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "runtime-manifest.json").read_text())
    venv = (root / ".venv").resolve()
    # -I -S disables user site, sitecustomize and .pth execution. Only this
    # fixed site-packages path is added, before metadata-based verification.
    sys.path.insert(0, str(venv / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"))
    for package in manifest["packages"]:
        dist = importlib.metadata.distribution(package["name"])
        if dist.version != package["version"]:
            raise RuntimeError("version drift")
        record = dist.read_text("RECORD")
        if not record or hashlib.sha256(record.encode()).hexdigest() != package["recordSha256"]:
            raise RuntimeError("record drift")
        for entry in dist.files or []:
            if entry.hash is None:
                continue
            target = Path(dist.locate_file(entry)).resolve()
            if not target.is_relative_to(venv) or entry.hash.mode != "sha256":
                raise RuntimeError("unexpected installed path/hash")
            actual = base64.urlsafe_b64encode(hashlib.sha256(target.read_bytes()).digest()).rstrip(b"=").decode()
            if actual != entry.hash.value:
                raise RuntimeError("file drift")


try:
    verify_install()
except Exception:
    # Never leak package paths or arbitrary installer/source exception text.
    sys.stderr.write("SEED_SOURCE_INSTALL_DRIFT\n")
    if sys.argv[1:] == ["--prepare-boundary"]:
        sys.stdout.write('{"error":"BOUNDARY_SOURCE_INSTALL_DRIFT","stages":[]}\n')
    sys.exit(78)

if __name__ == "__main__":
    if sys.argv[1:] == ["--prepare-boundary"]:
        # -I -S intentionally excludes the script directory. Load only this
        # fixed adjacent helper after installed-file verification has succeeded.
        import importlib.util
        spec = importlib.util.spec_from_file_location("factory_boundary", Path(__file__).parent / "boundary.py")
        boundary = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(boundary)
        sys.exit(boundary.main())
    elif sys.argv[1:]:
        sys.stderr.write("SEED_SOURCE_ARGUMENTS\n")
        sys.exit(64)
    else:
        from placeroot.server import mcp
        mcp.run()
