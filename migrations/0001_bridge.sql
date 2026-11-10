-- One row per linked router account: where its bot reports back.
CREATE TABLE routes (
  account_id TEXT PRIMARY KEY NOT NULL,
  subscription TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  active INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- status: sending | pending | done | error | failed. timed_out is derived from deadline_at.
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  prompt TEXT,
  status TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX runs_account ON runs (account_id, created_at);

-- Cached teammate roster, replaced whole by each roster run.
CREATE TABLE roster (
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  handles TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, name)
);
