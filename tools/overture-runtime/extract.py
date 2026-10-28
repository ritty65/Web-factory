"""Bounded local Houston Parquet import; no S3/httpfs/extensions/network."""
import json, sys, pathlib, stat
import duckdb

def main():
    request = json.loads(sys.stdin.buffer.read(8193))
    file = pathlib.Path(request["file"])
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 256 * 1024 * 1024 or file.suffix != ".parquet":
        raise ValueError("Expected a regular local Parquet file under 256 MiB")
    con = duckdb.connect(config={"threads": "1", "memory_limit": "128MB", "allow_unsigned_extensions": "false", "autoinstall_known_extensions": "false", "autoload_known_extensions": "false"})
    # The operator selects the local export; no SQL or remote path is accepted.
    con.execute("SET allowed_paths = ?", [[str(file.resolve())]])
    con.execute("SET enable_external_access = false")
    rows = con.execute("SELECT id,names,categories,sources,bbox,phones,websites FROM read_parquet(?) WHERE bbox.xmin >= -95.90 AND bbox.xmax <= -95.00 AND bbox.ymin >= 29.45 AND bbox.ymax <= 30.15 ORDER BY id LIMIT 1001", [str(file.resolve())]).fetchall()
    if len(rows) > 1000:
        raise ValueError("Narrow the local export to at most 1000 Houston records")
    result = []
    for identifier, names, categories, sources, bbox, phones, websites in rows:
        if not isinstance(names, dict) or not names.get("primary") or not sources:
            continue
        result.append({"id": identifier, "name": names["primary"], "categories": categories, "sources": sources, "longitude": (bbox["xmin"]+bbox["xmax"])/2, "latitude": (bbox["ymin"]+bbox["ymax"])/2, "phones": phones or [], "websites": websites or []})
    print(json.dumps({"rows": result}, separators=(",", ":")))

try:
    main()
except Exception:
    print("Overture local import failed validation; check the export schema and bounds.", file=sys.stderr)
    sys.exit(1)
