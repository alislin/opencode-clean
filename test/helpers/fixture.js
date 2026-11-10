import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, existingTables } from "../../lib/db.js";

/** Fixed epoch so expectations are deterministic. */
export const NOW = 1_700_000_000_000;
export const DAY = 86400000;
export const OLD = NOW - 40 * DAY;
export const RECENT = NOW - 1 * DAY;

const DDL = `
CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE, session_id TEXT, data TEXT NOT NULL, time_updated INTEGER);
CREATE TABLE todo (session_id TEXT NOT NULL, content TEXT, position INTEGER NOT NULL, PRIMARY KEY(session_id, position), FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE);
CREATE TABLE session_share (session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE);
CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY);
CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE, data TEXT);
CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_suspended INTEGER, time_busy INTEGER);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
CREATE TABLE session_part (message_id TEXT NOT NULL REFERENCES session_message(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, type TEXT, data TEXT NOT NULL, PRIMARY KEY(message_id, ordinal));
CREATE TABLE session_inbox (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE, payload TEXT);
CREATE TABLE instruction_entry (session_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(session_id, key), FOREIGN KEY(session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE instruction_state (session_id TEXT PRIMARY KEY REFERENCES session_v2(id) ON DELETE CASCADE, epoch_start INTEGER);
CREATE TABLE blob (hash TEXT PRIMARY KEY, mime TEXT, bytes INTEGER, data BLOB);
CREATE TABLE blob_ref (session_id TEXT NOT NULL, message_id TEXT NOT NULL, hash TEXT NOT NULL REFERENCES blob(hash) ON DELETE CASCADE, PRIMARY KEY(session_id, message_id, hash));
CREATE TABLE job (notification_id TEXT PRIMARY KEY, session_id TEXT, child_session_id TEXT);
CREATE TABLE schedule (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE, status TEXT);
`;

/**
 * Fixture contents and expected purge outcome:
 *
 * legacy (rule: id must exist in session_v2):
 *   ses_L1 (old, has v2 copy)      -> PURGED (+2 msg, 2 part, 1 todo, 1 share, 1 event, 1 event_sequence)
 *   ses_L2 (recent, has v2 copy)   -> PURGED (legacy rule is copy-based, age ignored) (+same children)
 *   ses_L3 (old, NO v2 copy)       -> KEPT (+children)
 *
 * v2 subagents (rule: parent_id set, updated < cutoff, not suspended):
 *   ses_VsubOld  (old)             -> PURGED (+2 session_message, 1 session_part, 1 inbox,
 *                                            1 instruction_entry, 1 instruction_state,
 *                                            1 blob_ref -> blob b1 becomes orphan,
 *                                            2 jobs, 1 schedule)
 *   ses_VsubNew  (recent)          -> KEPT (+1 session_message)
 *   ses_Vsusp    (old, suspended)  -> KEPT (+1 session_message)
 *   ses_Vmain    (main, old)       -> KEPT (+1 session_message msg_K1, 1 blob_ref -> blob b2)
 */
export const EXPECT = {
  legacy: { sessions: 2, message: 4, part: 4, todo: 2, session_share: 2, event: 2, event_sequence: 2, bytes: 4 * 100 + 4 * 50 },
  v2: {
    sessions: 1,
    session_message: 2,
    session_part: 1,
    session_inbox: 1,
    instruction_entry: 1,
    instruction_state: 1,
    blob_ref: 1,
    blob_orphan: 1,
    job: 2,
    schedule: 1,
    bytes: 2 * 200,
  },
};

export function makeTempDir(label = "oclean-test") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

export function createFixtureDb(dir, { wal = false } = {}) {
  const dbPath = path.join(dir, "opencode.db");
  const db = openDatabase(dbPath);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(DDL);

  const ins = (sql, ...p) => db.prepare(sql).run(...p);

  // --- legacy sessions (L1/L2 have migrated copies in session_v2) ---
  const legacySessions = [
    ["ses_L1", OLD],
    ["ses_L2", RECENT],
    ["ses_L3", OLD],
  ];
  for (const [id, ts] of legacySessions) ins(`INSERT INTO session (id, parent_id, time_created, time_updated) VALUES (?, NULL, ?, ?)`, id, ts, ts);
  ins(`INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES (?, NULL, ?, ?)`, "ses_L1", OLD, OLD);
  ins(`INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES (?, NULL, ?, ?)`, "ses_L2", RECENT, RECENT);
  let n = 0;
  for (const [sid, _] of legacySessions) {
    for (let m = 0; m < 2; m++) {
      const mid = `${sid}_msg${m}`;
      ins(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`, mid, sid, OLD, OLD, "m".repeat(100));
      ins(`INSERT INTO part (id, message_id, session_id, data, time_updated) VALUES (?, ?, ?, ?, ?)`, `${mid}_p0`, mid, sid, "p".repeat(50), OLD);
      n++;
    }
    ins(`INSERT INTO todo (session_id, content, position) VALUES (?, ?, ?)`, sid, "x", 0);
    ins(`INSERT INTO session_share (session_id) VALUES (?)`, sid);
    ins(`INSERT INTO event_sequence (aggregate_id) VALUES (?)`, sid);
    ins(`INSERT INTO event (id, aggregate_id, data) VALUES (?, ?, ?)`, `${sid}_ev0`, sid, "e");
  }

  // --- v2 sessions ---
  ins(`INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES (?, NULL, ?, ?)`, "ses_Vmain", OLD, OLD);
  ins(`INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?)`, "ses_VsubOld", "ses_Vmain", OLD, OLD);
  ins(`INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?)`, "ses_VsubNew", "ses_Vmain", RECENT, RECENT);
  ins(`INSERT INTO session_v2 (id, parent_id, time_created, time_updated, time_suspended) VALUES (?, ?, ?, ?, ?)`, "ses_Vsusp", "ses_Vmain", OLD, OLD, OLD);

  // ses_VsubOld children (2 messages -> purge)
  for (let m = 0; m < 2; m++) {
    ins(`INSERT INTO session_message (id, session_id, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`, `subold_msg${m}`, "ses_VsubOld", m, OLD, OLD, "d".repeat(200));
  }
  ins(`INSERT INTO session_part (message_id, session_id, ordinal, type, data) VALUES (?, ?, ?, ?, ?)`, "subold_msg0", "ses_VsubOld", 0, "tool", "t");
  ins(`INSERT INTO session_inbox (id, session_id, payload) VALUES (?, ?, ?)`, "ib0", "ses_VsubOld", "y");
  ins(`INSERT INTO instruction_entry (session_id, key) VALUES (?, ?)`, "ses_VsubOld", "k");
  ins(`INSERT INTO instruction_state (session_id, epoch_start) VALUES (?, ?)`, "ses_VsubOld", 1);
  ins(`INSERT INTO blob (hash, mime, bytes, data) VALUES (?, ?, ?, ?)`, "b1", "img/png", 500, Buffer.alloc(500, 1));
  ins(`INSERT INTO blob (hash, mime, bytes, data) VALUES (?, ?, ?, ?)`, "b2", "img/png", 500, Buffer.alloc(500, 2));
  ins(`INSERT INTO blob_ref (session_id, message_id, hash) VALUES (?, ?, ?)`, "ses_VsubOld", "subold_msg0", "b1");
  ins(`INSERT INTO job (notification_id, session_id, child_session_id) VALUES (?, ?, NULL)`, "J1", "ses_VsubOld");
  ins(`INSERT INTO job (notification_id, session_id, child_session_id) VALUES (?, NULL, ?)`, "J2", "ses_VsubOld");
  ins(`INSERT INTO schedule (id, session_id, status) VALUES (?, ?, ?)`, "S1", "ses_VsubOld", "active");

  // kept v2 children
  ins(`INSERT INTO session_message (id, session_id, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`, "subnew_msg0", "ses_VsubNew", 0, RECENT, RECENT, "d".repeat(200));
  ins(`INSERT INTO session_message (id, session_id, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`, "susp_msg0", "ses_Vsusp", 0, OLD, OLD, "d".repeat(200));
  ins(`INSERT INTO session_message (id, session_id, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`, "main_msg0", "ses_Vmain", 0, OLD, OLD, "d".repeat(200));
  ins(`INSERT INTO blob_ref (session_id, message_id, hash) VALUES (?, ?, ?)`, "ses_Vmain", "main_msg0", "b2");

  const tables = existingTables(db);
  return { db, dbPath, tables };
}

/** Create the on-disk storage tree with known orphans vs keepers. */
export function createStorageTree(storageRoot) {
  const mk = (rel, content = "{}") => {
    const p = path.join(storageRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  const mkdir = (rel) => {
    const p = path.join(storageRoot, rel);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  return {
    keeperSession: mk("storage/session/ses_Vmain.json"),
    orphanSession: mk("storage/session/ses_DEAD.json"),
    keeperMsgDir: mkdir("storage/message/ses_Vmain"),
    orphanMsgDir: mkdir("storage/message/ses_DEAD2"),
    orphanMsgFile: mk("storage/message/ses_DEAD3.json"),
    keeperPart: mkdir("storage/part/main_msg0"),
    orphanPart: mkdir("storage/part/msg_DEAD4"),
    keeperDiff: mk("storage/session_diff/ses_Vmain.json"),
    orphanDiff: mk("storage/session_diff/ses_DEAD5.json"),
    snapshotDir: mkdir("snapshot/proj1"),
    snapshotFile: mk("snapshot/proj1/pack.git", "s".repeat(100)),
  };
}

export function counts(db, table) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
}
