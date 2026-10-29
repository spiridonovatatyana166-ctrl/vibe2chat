-- Базовая схема VibeChat. Видео, аудио и тексты чата НЕ хранятся.

CREATE TABLE admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_gid     TEXT    NOT NULL,
  reported_gid     TEXT    NOT NULL,
  -- HMAC от IP нарушителя: нужен только для бана по сети, сам IP не хранится.
  reported_ip_hash TEXT,
  room_id          TEXT    NOT NULL,
  reason           TEXT    NOT NULL,
  details          TEXT,
  status           TEXT    NOT NULL DEFAULT 'open',
  handled_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (reporter_gid, room_id)
);
CREATE INDEX idx_reports_status  ON reports (status, created_at DESC);
CREATE INDEX idx_reports_reported ON reports (reported_gid, created_at);

CREATE TABLE bans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id   TEXT,
  ip_hash    TEXT,
  reason     TEXT    NOT NULL,
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  CHECK (guest_id IS NOT NULL OR ip_hash IS NOT NULL)
);
CREATE INDEX idx_bans_guest ON bans (guest_id);
CREATE INDEX idx_bans_ip    ON bans (ip_hash);

CREATE TABLE blocks (
  blocker_gid TEXT    NOT NULL,
  blocked_gid TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (blocker_gid, blocked_gid)
);
CREATE INDEX idx_blocks_blocked ON blocks (blocked_gid);

-- Агрегированная статистика без персональных данных.
CREATE TABLE stats_daily (
  day   TEXT    PRIMARY KEY,
  rooms INTEGER NOT NULL DEFAULT 0
);
