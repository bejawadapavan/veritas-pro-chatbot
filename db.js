const path = require('path');
let dbInstance;

// Determine SQLite driver: built-in node:sqlite (Node 22+) or better-sqlite3
const dbPath = path.join(__dirname, 'veritas_production.db');

try {
  const { DatabaseSync } = require('node:sqlite');
  dbInstance = new DatabaseSync(dbPath);
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA synchronous = NORMAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  console.log('[Database] Connected using built-in node:sqlite (WAL Mode)');
} catch (e) {
  try {
    const BetterSqlite = require('better-sqlite3');
    dbInstance = new BetterSqlite(dbPath);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('synchronous = NORMAL');
    dbInstance.pragma('foreign_keys = ON');
    console.log('[Database] Connected using better-sqlite3 (WAL Mode)');
  } catch (err) {
    console.error('[Database Error] Failed to initialize SQLite:', err);
    throw err;
  }
}

const db = dbInstance;

// Initialize Schemas
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    persona TEXT DEFAULT 'general',
    provider TEXT DEFAULT 'auto',
    model TEXT DEFAULT 'auto',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    thoughts TEXT,
    tool_meta TEXT,
    tokens INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    topic TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    verified_source TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    tool_name TEXT NOT NULL,
    parameters TEXT NOT NULL,
    result_summary TEXT,
    execution_status TEXT NOT NULL,
    latency_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    is_secret INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe column migrations in case previous database version exists
try {
  const sessionCols = db.prepare(`PRAGMA table_info(sessions)`).all().map(c => c.name);
  if (!sessionCols.includes('persona')) db.exec(`ALTER TABLE sessions ADD COLUMN persona TEXT DEFAULT 'general'`);
  if (!sessionCols.includes('provider')) db.exec(`ALTER TABLE sessions ADD COLUMN provider TEXT DEFAULT 'auto'`);
  if (!sessionCols.includes('model')) db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT DEFAULT 'auto'`);
  if (!sessionCols.includes('updated_at')) db.exec(`ALTER TABLE sessions ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);

  const messageCols = db.prepare(`PRAGMA table_info(messages)`).all().map(c => c.name);
  if (!messageCols.includes('thoughts')) db.exec(`ALTER TABLE messages ADD COLUMN thoughts TEXT`);
  if (!messageCols.includes('tokens')) db.exec(`ALTER TABLE messages ADD COLUMN tokens INTEGER DEFAULT 0`);

  const auditCols = db.prepare(`PRAGMA table_info(audit_logs)`).all().map(c => c.name);
  if (!auditCols.includes('session_id')) db.exec(`ALTER TABLE audit_logs ADD COLUMN session_id TEXT`);
  if (!auditCols.includes('result_summary')) db.exec(`ALTER TABLE audit_logs ADD COLUMN result_summary TEXT`);
} catch (migErr) {
  console.warn('[Database] Migration notice:', migErr.message);
}

// Seed Default Verified Knowledge Base Facts if empty
const factCount = db.prepare('SELECT COUNT(*) as count FROM knowledge_base').get().count;
if (factCount === 0) {
  const insertFact = db.prepare(`
    INSERT INTO knowledge_base (category, topic, content, verified_source)
    VALUES (?, ?, ?, ?)
  `);

  insertFact.run(
    'Architecture',
    'Agentic AI',
    'Agentic AI systems possess agency: they autonomously formulate multi-step execution plans, perceive dynamic environments, call external tools/APIs, and self-correct based on execution feedback.',
    'IEEE Transactions on AI / Research Standard'
  );
  insertFact.run(
    'Architecture',
    'ReAct Framework',
    'ReAct (Reasoning and Acting) intertwines reasoning traces with task-specific actions. By generating reasoning before calling tools and observing results before answering, hallucination is minimized by over 80%.',
    'Yao et al., Princeton / Google Research'
  );
  insertFact.run(
    'DevOps & SRE',
    'Kubernetes CrashLoopBackOff',
    'Occurs when an initialised container repeatedly terminates abnormally. The primary root cause in cloud workloads is exit code 137 (OOMKilled) caused by container memory limits being exceeded.',
    'Kubernetes Operational Manual'
  );
  insertFact.run(
    'Database Engineering',
    'SQLite WAL Mode',
    'Write-Ahead Logging (WAL) decouples reading and writing operations: concurrent readers execute uninterrupted while an individual writer appends changes to a .wal delta buffer.',
    'SQLite Official Architecture Documentation'
  );
  insertFact.run(
    'Software Security',
    'Prompt Injection',
    'An adversarial attack targeting LLMs where malicious inputs alter the model execution context, bypassing established safety policies or manipulating function call execution.',
    'OWASP Top 10 for LLM Applications'
  );
  insertFact.run(
    'Performance Optimization',
    'Retrieval-Augmented Generation (RAG)',
    'RAG enriches LLM queries with context retrieved dynamically from authoritative databases or document stores, guaranteeing real-time factuality without costly model retraining.',
    'Lewis et al., Meta AI / NeurIPS'
  );
}

// Ensure default workspace session exists
const defaultSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get('main-session');
if (!defaultSession) {
  db.prepare(`
    INSERT INTO sessions (id, title, persona, provider, model)
    VALUES (?, ?, ?, ?, ?)
  `).run('main-session', 'Main Production Workspace', 'general', 'auto', 'auto');
}

// Database Helpers
db.getSetting = (key, defaultValue = null) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
};

db.setSetting = (key, value, isSecret = 0) => {
  db.prepare(`
    INSERT INTO settings (key, value, is_secret, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value), isSecret ? 1 : 0);
};

db.getAllSettingsSafe = () => {
  const rows = db.prepare('SELECT key, value, is_secret, updated_at FROM settings').all();
  const result = {};
  for (const row of rows) {
    if (row.is_secret) {
      const val = row.value || '';
      if (val.length > 8) {
        result[row.key] = {
          configured: true,
          preview: `${val.slice(0, 4)}...${val.slice(-4)}`,
          updated_at: row.updated_at
        };
      } else {
        result[row.key] = {
          configured: val.length > 0,
          preview: val ? '••••••••' : '',
          updated_at: row.updated_at
        };
      }
    } else {
      result[row.key] = row.value;
    }
  }
  return result;
};

module.exports = db;
