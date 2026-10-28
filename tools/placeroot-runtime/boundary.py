"""Pinned 0.12.0 exact boundary setup. Invoked only after verify_install()."""
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import sys
import time

ROOT = Path(__file__).resolve().parent
MAX_CACHE = 32 * 1024 * 1024
ATTRIBUTION = ["Division boundary: © OpenStreetMap contributors, Overture Maps Foundation; ODbL-1.0 (separate divisions theme)."]


class BoundaryFailure(Exception):
    def __init__(self, stages):
        self.stages = list(stages)


def safe_path(path):
    if not isinstance(path, Path) or not path.is_absolute() or not path.is_relative_to(ROOT / "cache"):
        raise ValueError()
    if ".." in path.parts:
        raise ValueError()
    # Missing final components are allowed before the native writer runs, but
    # existing non-directories/symlinks are not. No deletion/overwrite by us.
    current = ROOT
    if current.is_symlink() or not current.is_dir():
        raise ValueError()
    for part in path.relative_to(ROOT).parts:
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode) or (current != path and not stat.S_ISDIR(mode)) or (current == path and not stat.S_ISREG(mode)):
            raise ValueError()


def read_cache(path):
    safe_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 42 <= before.st_size <= MAX_CACHE:
            raise ValueError()
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(MAX_CACHE + 1)
        after = os.fstat(fd)
        if len(data) != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError()
        if data[0] != 1 or data[33] not in (0, 1):
            raise ValueError()
        bbox = struct.unpack("<4d", data[1:33])
        if not all(math.isfinite(v) for v in bbox) or not (-180 <= bbox[0] <= bbox[1] <= 180 and -90 <= bbox[2] <= bbox[3] <= 90):
            raise ValueError()
        return data, bbox
    finally:
        os.close(fd)


def prepare_boundary():
    stages = []

    def timed(stage, operation):
        start = time.monotonic()
        sys.stderr.write(json.dumps({"stage": stage, "durationMs": 0, "outcome": "running"}) + "\n")
        sys.stderr.flush()
        outcome = "failed"
        try:
            value = operation()
            outcome = "ok"
            return value
        finally:
            record = {"stage": stage, "durationMs": round((time.monotonic() - start) * 1000, 3), "outcome": outcome}
            stages.append(record)
            sys.stderr.write(json.dumps(record) + "\n")
            sys.stderr.flush()

    try:
        from placeroot import geocode, overture, resources
        version = timed("version", resources.data_version_payload)
        release = version.get("release")
        if not isinstance(release, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d+", release) or len(release) > 32 or not version.get("source") or version.get("stale") or version.get("recreation_layer"):
            raise ValueError()
        area = timed("area", lambda: geocode.resolve_area("Houston, Texas"))
        if not area or area.get("name") != "Houston" or not isinstance(area.get("division_id"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,200}", area["division_id"]) or not isinstance(area.get("admin_context"), list):
            raise ValueError()
        division = area["division_id"]
        upstream = overture._upstream_glob(theme="divisions", type_="division_area")
        # Assert the inspected native default instead of accepting a mirror/path
        # override or a changed active release. No guessed cache/GERS identifier.
        if upstream != f"s3://overturemaps-us-west-2/release/{release}/theme=divisions/type=division_area/*":
            raise ValueError()
        glob_hash = hashlib.sha256(upstream.encode()).hexdigest()
        expected = ROOT / "cache" / "division_polygons" / glob_hash[:16] / (hashlib.sha256(division.encode()).hexdigest()[:32] + ".bin")
        path = overture._division_polygon_disk_path(upstream, division)
        if path != expected:
            raise ValueError()
        safe_path(path)
        # Do not let native corruption recovery overwrite an uncertain cache.
        if path.exists():
            read_cache(path)
        # Transparent, temporary timing wrappers: native args/results/exceptions
        # unchanged; no installed package edits or additional schema/source calls.
        originals = {}
        for name, stage in [("_ensure_spatial", "extension"), ("missing_columns", "schema")]:
            if hasattr(overture, name):
                original = getattr(overture, name)
                originals[name] = original
                def wrapper(*args, _fn=original, _stage=stage, **kwargs):
                    return timed(_stage, lambda: _fn(*args, **kwargs))
                setattr(overture, name, wrapper)
        try:
            resolved = timed("polygon", lambda: overture._resolve_division_geometry(division))
        finally:
            for name, original in originals.items():
                setattr(overture, name, original)

        def verify():
            data, bbox = read_cache(path)
            if not resolved or len(resolved) != 5 or bytes(resolved[0]) != data[33:] or tuple(resolved[1:]) != bbox:
                raise ValueError()
            return data, bbox
        data, bbox = timed("cache", verify)
        return {"provider": "placeroot", "packageVersion": "0.12.0", "release": release,
                "divisionId": division, "areaName": "Houston", "cacheRelative": path.relative_to(ROOT).as_posix(),
                "sourceGlobSha256": glob_hash, "cacheSha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data), "bbox": list(bbox), "attribution": ATTRIBUTION, "stages": stages}
    except Exception:
        raise BoundaryFailure(stages) from None


def main():
    # Package stdout/logs never become protocol/source bodies. Progress consists
    # only of fixed stage names/outcomes/durations. Parent independently bounds it.
    try:
        with contextlib.redirect_stdout(sys.stderr):
            receipt = prepare_boundary()
        text = json.dumps(receipt, allow_nan=False, separators=(",", ":"))
        if len(text.encode()) > 64 * 1024:
            raise ValueError()
        sys.stdout.write(text + "\n")
        return 0
    except Exception as exc:
        stages = exc.stages if isinstance(exc, BoundaryFailure) else []
        sys.stdout.write(json.dumps({"error": "BOUNDARY_SOURCE_UNAVAILABLE", "stages": stages}, allow_nan=False) + "\n")
        return 1
