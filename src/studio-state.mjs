import {fail} from './contracts.mjs';

export function record(store,id,kind){
  if(!store.db?.prepare||!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_operation'").get())return null;
  const row=store.db.prepare('SELECT record FROM factory_operation WHERE id=? AND kind=?').get(id,kind);
  return row?JSON.parse(row.record):null;
}
export function records(store,kind){
  if(!store.db?.prepare||!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_operation'").get())return [];
  return store.db.prepare('SELECT record FROM factory_operation WHERE kind=? ORDER BY rowid DESC').all(kind).map(row=>JSON.parse(row.record));
}
export function saveRecord(store,id,kind,value){
  const result=store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record WHERE factory_operation.kind=excluded.kind').run(id,kind,JSON.stringify(value));
  if(!result.changes)fail('STATE_NAMESPACE','Record identity belongs to a different operation type');
  return value;
}
export function atomic(store,fn){
  if(store.db.isTransaction)return fn();
  store.db.exec('BEGIN IMMEDIATE');
  try{const result=fn();store.db.exec('COMMIT');return result;}
  catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
}
