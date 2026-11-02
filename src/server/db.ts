// SQLite schema and migrations. One integration owner; append migrations, never edit old ones.
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS: string[] = [
  `
  create table meta(key text primary key, value text not null);
  insert into meta values('revision', '0'), ('retention_revision', '0');

  create table nights(
    id text primary key,
    status text not null check(status in ('open','closed')),
    opened_at integer not null,
    closed_at integer
  );
  create unique index one_open_night on nights(status) where status = 'open';

  create table master_items(
    id text primary key,
    order_key real not null,
    source_url text not null,
    provider text not null,
    title text not null,
    artist text,
    duration_sec real not null,
    recording_key text not null,
    selection text not null,
    status text not null check(status in ('preparing','ready','failed','unusable')),
    job_id text,
    asset text,
    prep_attempts integer not null default 0,
    failures integer not null default 0,
    error text,
    removed integer not null default 0,
    created_at integer not null
  );

  create table requests(
    id text primary key,
    night_id text not null references nights(id),
    requester_key text not null,
    requester_name text not null,
    order_key real not null,
    source_url text not null,
    provider text not null,
    title text not null,
    artist text,
    duration_sec real not null,
    recording_key text not null,
    selection text not null,
    status text not null check(status in ('preparing','ready','playing','played','failed','removed','skipped','archived')),
    job_id text,
    asset text,
    prep_attempts integer not null default 0,
    play_attempts integer not null default 0,
    charged integer not null default 1,
    refunded integer not null default 0,
    error text,
    created_at integer not null,
    finished_at integer
  );
  create index requests_queue on requests(night_id, status, order_key);
  create index requests_quota on requests(night_id, requester_key);

  -- Singleton scheduler/playback checkpoint. Positions are seconds; times are epoch ms.
  create table playback(
    id integer primary key check(id = 1),
    phase text not null check(phase in ('master','request')),
    intent text not null check(intent in ('playing','paused')),
    period_started_at integer,
    current_id text,
    master_cursor text,
    master_position real not null default 0,
    suspended text,
    epoch integer not null default 0,
    load_id integer not null default 0,
    start_position real not null default 0,
    seek_seq integer not null default 0,
    seek_epoch integer not null default 0,
    volume real not null default 0.8,
    desired_at integer not null default 0,
    generation integer not null default 0,
    lease_device text,
    lease_expires integer not null default 0,
    observed text,
    acked_epoch integer,
    unconfirmed_noted integer not null default 0,
    no_master integer not null default 0
  );
  insert into playback(id, phase, intent) values(1, 'master', 'paused');

  create table devices(
    id text primary key,
    name text not null,
    token_hash text not null,
    paired_at integer not null,
    revoked integer not null default 0
  );
  create table pairing_codes(
    code_hash text primary key,
    name text not null,
    expires_at integer not null,
    used integer not null default 0
  );

  -- Stable command IDs: final responses replay instead of re-executing.
  create table commands(
    id text primary key,
    actor text not null,
    type text not null,
    payload_hash text not null,
    response text not null,
    created_at integer not null
  );

  create table events(
    seq integer primary key autoincrement,
    revision integer not null,
    at integer not null,
    type text not null,
    data text not null
  );

  create table sessions(
    id_hash text primary key,
    identity text not null,
    expires_at integer not null
  );
  `,
  `
  alter table master_items add column artwork_url text;
  alter table requests add column artwork_url text;
  `,
  `alter table devices add column automatic integer not null default 0;
   alter table playback add column autostart integer not null default 0;`,
  // Queue playback controls: shared mode and request-interval override (null = policy default).
  `alter table playback add column mode text not null default 'auto' check(mode in ('auto','master','requests'));
   alter table playback add column period_ms integer;`,
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma synchronous = full; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  const version = (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
  if (version > MIGRATIONS.length) {
    throw new Error(`Database schema ${version} is newer than this service (${MIGRATIONS.length})`);
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('begin immediate');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  }
  return db;
}
