#!/usr/bin/env python3
"""Read-only canonical checks; restore/migrate only new disposable DB copies."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timezone

PROJECT = Path(__file__).resolve().parents[1]
STATE = Path('/home/ai_dev/07_OPERATIONS/simulacra-factory')
DB = Path('/home/ai_dev/07_OPERATIONS/simulacra-business-library/library.sqlite3')
OUT = Path('/home/ai_dev/04_DELIVERABLES/simulacra-factory-20261021/verification')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def readonly(file):
    return sqlite3.connect(file.as_uri() + '?mode=ro', uri=True)


baseline = json.loads((STATE / 'preservation-baseline.json').read_text())
business_ids = [row[0] for row in baseline['business_rows']]
with readonly(DB) as db:
    placeholders = ','.join('?' for _ in business_ids)
    originals = db.execute('SELECT * FROM business WHERE id IN (' + placeholders + ') ORDER BY id', business_ids).fetchall()
    files = db.execute('SELECT * FROM file WHERE business_id IN (' + placeholders + ') ORDER BY id', business_ids).fetchall()
    assert json.loads(json.dumps(originals)) == baseline['business_rows'], 'Original business rows changed'
    assert digest(files) == baseline['file_rows_sha256'], 'Original indexed file rows changed'
    assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]

sites = {}
for name, root in [
    ('cakemake', '/home/ai_dev/04_DELIVERABLES/simulacra-pilot-20261021/cakemake/site'),
    ('h-details', '/home/ai_dev/04_DELIVERABLES/simulacra-pilot-20261021/h-details/site'),
    ('cream-burger', '/home/ai_dev/04_DELIVERABLES/simulacra-quality-reset-20261020/cream-burger-concept/site'),
]:
    directory = Path(root)
    actual = {str(f.relative_to(directory)): hashlib.sha256(f.read_bytes()).hexdigest()
              for f in sorted(directory.rglob('*')) if f.is_file()}
    assert actual == baseline['sites'][name], name + ' site bytes changed'
    sites[name] = {'files': len(actual), 'all_match_baseline': True}

temporary = Path(tempfile.mkdtemp(prefix='factory-restore-', dir='/tmp'))
pre = sorted((STATE / 'backups').glob('library-before-factory-*.sqlite3'))[0]
restored = temporary / 'pre-migration-restored.sqlite3'
with readonly(pre) as source, sqlite3.connect(restored) as target:
    source.backup(target)
restored.chmod(0o600)
with readonly(restored) as check:
    assert check.execute('SELECT count(*) FROM business').fetchone()[0] == 3
    assert check.execute("SELECT count(*) FROM sqlite_master WHERE name LIKE 'factory_%'").fetchone()[0] == 0
    assert digest(check.execute('SELECT * FROM file ORDER BY id').fetchall()) == baseline['file_rows_sha256']

env = {**os.environ, 'FACTORY_DB': str(restored), 'FACTORY_STATE': str(temporary / 'state'), 'FACTORY_AUTORUN': '0'}
subprocess.run(['node', 'src/cli.mjs', 'init'], cwd=PROJECT, env=env, check=True, capture_output=True, timeout=30)
with readonly(restored) as check:
    assert json.loads(json.dumps(check.execute('SELECT * FROM business ORDER BY id').fetchall())) == baseline['business_rows']
    assert digest(check.execute('SELECT * FROM file ORDER BY id').fetchall()) == baseline['file_rows_sha256']
    assert check.execute('PRAGMA integrity_check').fetchall() == [('ok',)]

current_copy = temporary / 'current-restored.sqlite3'
with readonly(DB) as source, sqlite3.connect(current_copy) as target:
    source.backup(target)
current_copy.chmod(0o600)
with readonly(DB) as source, readonly(current_copy) as target:
    tables = [r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    rows = {}
    for table in tables:
        assert table.replace('_', '').isalnum()
        before = source.execute('SELECT * FROM "' + table + '" ORDER BY rowid').fetchall()
        after = target.execute('SELECT * FROM "' + table + '" ORDER BY rowid').fetchall()
        assert before == after, 'Restored table differs: ' + table
        rows[table] = len(before)
    assert target.execute('PRAGMA integrity_check').fetchall() == [('ok',)]

result = {
    'at': datetime.now(timezone.utc).isoformat(), 'pass': True,
    'coverage': 'Actual library backup restored and migrated in disposable copies; canonical DB was not restored or overwritten',
    'original_business_rows_preserved': len(business_ids), 'original_file_rows_preserved': len(files),
    'sites': sites, 'pre_factory_backup_restored': True,
    'migration_of_restored_backup_preserved_all_original_rows': True,
    'current_database_backup_restore_all_tables_equal': True, 'restored_table_rows': rows,
    'private_restore_copies': str(temporary), 'no_hosted_write_or_customer_revision_operation': True,
}
OUT.mkdir(parents=True, exist_ok=True)
report = OUT / 'PRESERVATION-AND-RESTORE.json'
report.write_text(json.dumps(result, indent=2))
report.chmod(0o640)
print(json.dumps(result, indent=2))
