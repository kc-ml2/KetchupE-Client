export const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder'))
);
CREATE TABLE IF NOT EXISTS source_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  mapping TEXT NOT NULL,
  verified_fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active_task TEXT,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_collections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, collection)
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_workspace_updated ON threads(workspace_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_user', 'completed', 'abstained', 'failed', 'cancelled')),
  retrieval_profile TEXT NOT NULL,
  policy_profile TEXT NOT NULL,
  answer_profile TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_thread_status ON runs(thread_id, status);
CREATE TABLE IF NOT EXISTS run_actions (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  selection TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_open_per_thread ON runs(thread_id) WHERE status IN ('running', 'waiting_user');
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  applied_context TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread_created ON messages(thread_id, created_at, id);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'task')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'deleted')),
  pinned INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  locator TEXT,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS trace_events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  parent_seq INTEGER,
  type TEXT NOT NULL,
  stage TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS citations (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  locator TEXT NOT NULL,
  PRIMARY KEY (run_id, evidence_id)
);
CREATE TABLE IF NOT EXISTS business_jobs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS business_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  audit TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS canvases (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  canvas_type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  title TEXT,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('drafting', 'editing', 'finalized')),
  head_version_id TEXT,
  refs TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canvases_run ON canvases(run_id);
CREATE TABLE IF NOT EXISTS canvas_versions (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  base_version_id TEXT,
  op TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS canvas_versions_canvas ON canvas_versions(canvas_id, seq);
CREATE TABLE IF NOT EXISTS interaction_events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS telemetry_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'trace', 'score')),
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  payload TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS telemetry_outbox_pending ON telemetry_outbox(sent_at, created_at);
`;
