const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');
const multer = require('multer');
const db = require('./db');
const agent = require('./agent');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer memory storage for in-memory document parsing
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB limit
});

const crypto = require('crypto');
let appMasterKey = db.getSetting('APP_API_KEY') || process.env.APP_API_KEY;
if (!appMasterKey) {
  appMasterKey = 'vpro_live_' + crypto.randomBytes(20).toString('hex');
  db.setSetting('APP_API_KEY', appMasterKey, 0);
}

// -------------------------------------------------------------
// System Status & Telemetry
// -------------------------------------------------------------
app.get('/api/status', (req, res) => {
  try {
    const sessionCount = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
    const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
    const kbCount = db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get().c;
    const docCount = db.prepare('SELECT COUNT(*) as c FROM documents').get().c;
    const auditCount = db.prepare('SELECT COUNT(*) as c FROM audit_logs').get().c;

    const openAIKey = agent.getKey('OPENAI_API_KEY');
    const geminiKey = agent.getKey('GEMINI_API_KEY') || agent.getKey('GOOGLE_API_KEY');
    const groqKey = agent.getKey('GROQ_API_KEY');
    const openRouterKey = agent.getKey('OPENROUTER_API_KEY');
    const anthropicKey = agent.getKey('ANTHROPIC_API_KEY');

    let activeEngine = 'Local Deterministic ReAct (Zero-Config)';
    if (geminiKey) activeEngine = 'Google Gemini (Connected)';
    else if (openAIKey) activeEngine = 'OpenAI GPT-4o (Connected)';
    else if (groqKey) activeEngine = 'Groq Llama 3.3 (Connected)';
    else if (openRouterKey) activeEngine = 'OpenRouter (Connected)';
    else if (anthropicKey) activeEngine = 'Anthropic Claude (Connected)';

    const userProfile = db.getUserProfile('default_user');

    res.json({
      database: 'Connected (SQLite WAL Mode)',
      activeEngine,
      appMasterKey,
      userProfile,
      toolsCount: Object.keys(agent.tools).length,
      stats: {
        sessions: sessionCount,
        messages: msgCount,
        knowledge_facts: kbCount,
        documents: docCount,
        audit_executions: auditCount
      },
      telemetry: {
        node_version: process.version,
        uptime_seconds: Math.floor(process.uptime()),
        heap_used_mb: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
        system_time: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/keys/regenerate', (req, res) => {
  try {
    const newKey = 'vpro_live_' + crypto.randomBytes(20).toString('hex');
    db.setSetting('APP_API_KEY', newKey, 0);
    appMasterKey = newKey;
    res.json({ success: true, appMasterKey: newKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Sessions Endpoints (Multi-Chat Management)
// -------------------------------------------------------------
app.get('/api/sessions', (req, res) => {
  try {
    const sessions = db.prepare(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count,
        (SELECT content FROM messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) as last_message
      FROM sessions s 
      ORDER BY s.updated_at DESC
    `).all();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', (req, res) => {
  try {
    const { title, persona = 'general', provider = 'auto', model = 'auto' } = req.body;
    const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const sessionTitle = title && title.trim() ? title.trim() : 'New Autonomous Session';

    db.prepare(`
      INSERT INTO sessions (id, title, persona, provider, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, sessionTitle, persona, provider, model);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/sessions/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { title, persona, provider, model } = req.body;
    const current = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!current) return res.status(404).json({ error: 'Session not found' });

    db.prepare(`
      UPDATE sessions 
      SET title = COALESCE(?, title),
          persona = COALESCE(?, persona),
          provider = COALESCE(?, provider),
          model = COALESCE(?, model),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(title, persona, provider, model, id);

    const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM documents WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM audit_logs WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Message History Endpoints
// -------------------------------------------------------------
app.get('/api/sessions/:id/messages', (req, res) => {
  try {
    const { id } = req.params;
    const messages = db.prepare(`
      SELECT id, session_id, role, content, thoughts, tool_meta, tokens, created_at 
      FROM messages 
      WHERE session_id = ? 
      ORDER BY id ASC
    `).all(id);

    const parsed = messages.map(m => ({
      ...m,
      tool_meta: m.tool_meta ? JSON.parse(m.tool_meta) : null,
      thoughts: m.thoughts ? JSON.parse(m.thoughts) : null
    }));

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id/messages', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Main Autonomous Agent Chat Route (ReAct Loop)
// -------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const {
    sessionId = 'main-session',
    message,
    persona = 'general',
    provider = 'auto',
    model = 'auto',
    tone = null,
    userId = 'default_user'
  } = req.body;

  if (!message || message.trim() === '') {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  try {
    // 1. Ensure session exists
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) {
      db.prepare('INSERT INTO sessions (id, title, persona) VALUES (?, ?, ?)')
        .run(sessionId, message.slice(0, 40) + '...', persona);
    }

    // 2. Save Operator's User message
    db.prepare(`
      INSERT INTO messages (session_id, role, content) 
      VALUES (?, 'user', ?)
    `).run(sessionId, message);

    // 3. Execute Autonomous ReAct Agent Loop
    const agentResult = await agent.runAgentTurn({
      sessionId,
      message,
      persona: persona || (session ? session.persona : 'general'),
      preferredProvider: provider !== 'auto' ? provider : (session ? session.provider : 'auto'),
      preferredModel: model !== 'auto' ? model : (session ? session.model : 'auto'),
      tone,
      userId
    });

    // 4. Save Assistant message with thoughts and tool traces
    const thoughtsJson = agentResult.steps && agentResult.steps.length > 0 
      ? JSON.stringify(agentResult.steps.map(s => s.thought)) 
      : null;
    const toolMetaJson = agentResult.steps && agentResult.steps.length > 0 
      ? JSON.stringify(agentResult.steps) 
      : null;

    db.prepare(`
      INSERT INTO messages (session_id, role, content, thoughts, tool_meta)
      VALUES (?, 'assistant', ?, ?, ?)
    `).run(sessionId, agentResult.reply, thoughtsJson, toolMetaJson);

    // 5. Update session timestamp
    db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);

    res.json({
      response: agentResult.reply,
      steps: agentResult.steps,
      provider: agentResult.provider,
      latency: agentResult.latency
    });
  } catch (err) {
    console.error('[Agent Route Error]:', err);
    res.status(500).json({
      error: err.message,
      response: `An error occurred during agent execution: ${err.message}. If using an external provider, please check your API key in Settings.`
    });
  }
});

// -------------------------------------------------------------
// User Profile & Conversational Settings Endpoints
// -------------------------------------------------------------
app.get('/api/profile', (req, res) => {
  try {
    const userId = req.query.userId || 'default_user';
    const profile = db.getUserProfile(userId);
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profile', (req, res) => {
  try {
    const { userId = 'default_user', display_name, tone_style, custom_instructions, voice_enabled } = req.body;
    const updated = db.saveUserProfile(userId, {
      display_name,
      tone_style,
      custom_instructions,
      voice_enabled
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Message Regeneration Route
// -------------------------------------------------------------
app.post('/api/chat/regenerate', async (req, res) => {
  const {
    sessionId = 'main-session',
    tone = null,
    persona = 'general',
    provider = 'auto',
    model = 'auto',
    userId = 'default_user'
  } = req.body;

  try {
    // Find the latest user message
    const lastUserMsg = db.prepare(`
      SELECT id, content FROM messages 
      WHERE session_id = ? AND role = 'user' 
      ORDER BY id DESC LIMIT 1
    `).get(sessionId);

    if (!lastUserMsg) {
      return res.status(400).json({ error: 'No message available to regenerate.' });
    }

    // Remove any assistant responses that occurred after this user message
    db.prepare(`
      DELETE FROM messages 
      WHERE session_id = ? AND role = 'assistant' AND id > ?
    `).run(sessionId, lastUserMsg.id);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);

    // Re-run agent turn
    const agentResult = await agent.runAgentTurn({
      sessionId,
      message: lastUserMsg.content,
      persona: persona || (session ? session.persona : 'general'),
      preferredProvider: provider !== 'auto' ? provider : (session ? session.provider : 'auto'),
      preferredModel: model !== 'auto' ? model : (session ? session.model : 'auto'),
      tone,
      userId
    });

    const thoughtsJson = agentResult.steps && agentResult.steps.length > 0 
      ? JSON.stringify(agentResult.steps.map(s => s.thought)) 
      : null;
    const toolMetaJson = agentResult.steps && agentResult.steps.length > 0 
      ? JSON.stringify(agentResult.steps) 
      : null;

    db.prepare(`
      INSERT INTO messages (session_id, role, content, thoughts, tool_meta)
      VALUES (?, 'assistant', ?, ?, ?)
    `).run(sessionId, agentResult.reply, thoughtsJson, toolMetaJson);

    db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);

    res.json({
      response: agentResult.reply,
      steps: agentResult.steps,
      provider: agentResult.provider,
      latency: agentResult.latency
    });
  } catch (err) {
    console.error('[Regenerate Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Settings & Dynamic API Key Management
// -------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  try {
    const safeSettings = db.getAllSettingsSafe();

    // Check availability of environment keys as fallbacks
    const envStatus = {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      GEMINI_API_KEY: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      GROQ_API_KEY: !!process.env.GROQ_API_KEY,
      OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
    };

    res.json({
      settings: safeSettings,
      envFallbacks: envStatus,
      defaultProvider: db.getSetting('DEFAULT_PROVIDER', 'auto'),
      defaultModel: db.getSetting('DEFAULT_MODEL', 'auto')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const {
      OPENAI_API_KEY,
      GEMINI_API_KEY,
      GROQ_API_KEY,
      OPENROUTER_API_KEY,
      ANTHROPIC_API_KEY,
      OLLAMA_HOST,
      DEFAULT_PROVIDER,
      DEFAULT_MODEL
    } = req.body;

    if (OPENAI_API_KEY !== undefined) db.setSetting('OPENAI_API_KEY', OPENAI_API_KEY.trim(), 1);
    if (GEMINI_API_KEY !== undefined) db.setSetting('GEMINI_API_KEY', GEMINI_API_KEY.trim(), 1);
    if (GROQ_API_KEY !== undefined) db.setSetting('GROQ_API_KEY', GROQ_API_KEY.trim(), 1);
    if (OPENROUTER_API_KEY !== undefined) db.setSetting('OPENROUTER_API_KEY', OPENROUTER_API_KEY.trim(), 1);
    if (ANTHROPIC_API_KEY !== undefined) db.setSetting('ANTHROPIC_API_KEY', ANTHROPIC_API_KEY.trim(), 1);
    if (OLLAMA_HOST !== undefined) db.setSetting('OLLAMA_HOST', OLLAMA_HOST.trim(), 0);
    if (DEFAULT_PROVIDER !== undefined) db.setSetting('DEFAULT_PROVIDER', DEFAULT_PROVIDER, 0);
    if (DEFAULT_MODEL !== undefined) db.setSetting('DEFAULT_MODEL', DEFAULT_MODEL, 0);

    res.json({ success: true, message: 'Settings and API keys saved successfully to SQLite.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/test-key', async (req, res) => {
  const { provider, apiKey, host } = req.body;
  const start = Date.now();

  try {
    if (!provider) return res.status(400).json({ error: 'Provider is required' });

    if (provider === 'gemini') {
      const key = apiKey || agent.getKey('GEMINI_API_KEY') || agent.getKey('GOOGLE_API_KEY');
      if (!key) return res.status(400).json({ error: 'No Gemini key provided' });

      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const testRes = await model.generateContent('ping');
      return res.json({
        success: true,
        latency: Date.now() - start,
        message: 'Google Gemini API key verified successfully! Models ready.'
      });
    }

    if (provider === 'openai') {
      const key = apiKey || agent.getKey('OPENAI_API_KEY');
      if (!key) return res.status(400).json({ error: 'No OpenAI key provided' });

      const { OpenAI } = require('openai');
      const client = new OpenAI({ apiKey: key });
      const models = await client.models.list();
      return res.json({
        success: true,
        latency: Date.now() - start,
        message: `OpenAI key valid! Found ${models.data.length} accessible models.`
      });
    }

    if (provider === 'groq') {
      const key = apiKey || agent.getKey('GROQ_API_KEY');
      if (!key) return res.status(400).json({ error: 'No Groq key provided' });

      const { OpenAI } = require('openai');
      const client = new OpenAI({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1' });
      const models = await client.models.list();
      return res.json({
        success: true,
        latency: Date.now() - start,
        message: `Groq key valid! ${models.data.length} ultra-fast models available.`
      });
    }

    if (provider === 'openrouter') {
      const key = apiKey || agent.getKey('OPENROUTER_API_KEY');
      if (!key) return res.status(400).json({ error: 'No OpenRouter key provided' });

      const resFetch = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${key}` }
      });
      if (!resFetch.ok) throw new Error(`HTTP ${resFetch.status}: Key validation failed.`);
      return res.json({
        success: true,
        latency: Date.now() - start,
        message: 'OpenRouter / DeepSeek key validated successfully!'
      });
    }

    if (provider === 'ollama') {
      const endpoint = host || agent.getKey('OLLAMA_HOST') || 'http://127.0.0.1:11434';
      const resFetch = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!resFetch.ok) throw new Error(`HTTP ${resFetch.status}`);
      const data = await resFetch.json();
      return res.json({
        success: true,
        latency: Date.now() - start,
        message: `Ollama endpoint connected! Found ${data.models ? data.models.length : 0} local model(s).`
      });
    }

    res.status(400).json({ error: 'Unsupported provider for testing.' });
  } catch (err) {
    res.status(400).json({
      success: false,
      latency: Date.now() - start,
      error: `Validation failed: ${err.message}`
    });
  }
});

// -------------------------------------------------------------
// Available Tools Inspection
// -------------------------------------------------------------
app.get('/api/tools', (req, res) => {
  res.json({
    tools: agent.toolDefinitions.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }))
  });
});

// -------------------------------------------------------------
// Knowledge Base Management (Audited Facts)
// -------------------------------------------------------------
app.get('/api/knowledge', (req, res) => {
  try {
    const records = db.prepare('SELECT * FROM knowledge_base ORDER BY id DESC').all();
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/knowledge', (req, res) => {
  const { category, topic, content, source } = req.body;
  if (!topic || !content) return res.status(400).json({ error: 'Topic and content are required.' });

  try {
    db.prepare(`
      INSERT INTO knowledge_base (category, topic, content, verified_source)
      VALUES (?, ?, ?, ?)
    `).run(category || 'General', topic.trim(), content.trim(), source || 'Manual Ingestion');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/knowledge/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(id);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Document Ingestion & RAG Memory
// -------------------------------------------------------------
app.get('/api/documents', (req, res) => {
  try {
    const docs = db.prepare('SELECT id, session_id, filename, file_type, file_size, summary, created_at FROM documents ORDER BY id DESC').all();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    let filename, content, fileType, fileSize;

    if (req.file) {
      filename = req.file.originalname;
      content = req.file.buffer.toString('utf-8');
      fileType = req.file.mimetype;
      fileSize = req.file.size;
    } else if (req.body.content) {
      filename = req.body.filename || `document_${Date.now()}.txt`;
      content = req.body.content;
      fileType = req.body.type || 'text/plain';
      fileSize = Buffer.byteLength(content, 'utf-8');
    } else {
      return res.status(400).json({ error: 'No file or content provided.' });
    }

    const sessionId = req.body.sessionId || null;
    const summary = content.slice(0, 180) + '...';

    const insert = db.prepare(`
      INSERT INTO documents (session_id, filename, file_type, file_size, content, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, filename, fileType, fileSize, content, summary);

    res.json({
      success: true,
      documentId: insert.lastInsertRowid,
      filename,
      size: fileSize,
      summary
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/documents/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Live Tool Audit Logs
// -------------------------------------------------------------
app.get('/api/audit-logs', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50').all();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// SQLite Database Inspector (Read-Only Explorer)
// -------------------------------------------------------------
app.post('/api/database/query', (req, res) => {
  const { sql } = req.body;
  if (!sql) return res.status(400).json({ error: 'SQL query required' });

  const disallowed = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|DETACH|VACUUM)\b/i;
  if (disallowed.test(sql)) {
    return res.status(403).json({ error: 'Security policy: Only read-only queries (SELECT, PRAGMA) are permitted.' });
  }

  try {
    const rows = db.prepare(sql.trim()).all();
    res.json({ success: true, rowCount: rows.length, rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Export Conversation / Session
// -------------------------------------------------------------
app.get('/api/export/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const format = req.query.format || 'json';

  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const messages = db.prepare('SELECT role, content, thoughts, tool_meta, created_at FROM messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);

    if (format === 'markdown' || format === 'md') {
      let md = `# Conversation Export: ${session.title}\n\n`;
      md += `*Session ID:* \`${session.id}\` | *Persona:* \`${session.persona}\` | *Date:* ${session.created_at}\n\n---\n\n`;

      for (const m of messages) {
        md += `### ${m.role === 'user' ? '👤 Operator' : '✨ Veritas Pro Agent'} (${m.created_at})\n\n`;
        if (m.tool_meta) {
          const tools = JSON.parse(m.tool_meta);
          md += `> **Tools Invoked:** ${tools.map(t => t.tool).join(', ')}\n\n`;
        }
        md += `${m.content}\n\n---\n\n`;
      }

      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="${session.title.replace(/[^a-z0-9]/gi, '_')}.md"`);
      return res.send(md);
    }

    res.json({
      session,
      exported_at: new Date().toISOString(),
      messages: messages.map(m => ({
        ...m,
        tool_meta: m.tool_meta ? JSON.parse(m.tool_meta) : null,
        thoughts: m.thoughts ? JSON.parse(m.thoughts) : null
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Public End-User Chatbot & Widget Routes
// -------------------------------------------------------------
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/widget-demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'embed-demo.html'));
});

app.get('/api/deployment-info', (req, res) => {
  try {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    const localIps = [];

    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIps.push({
            name,
            ip: iface.address,
            chatUrl: `http://${iface.address}:${PORT}/chat`,
            dashboardUrl: `http://${iface.address}:${PORT}`
          });
        }
      }
    }

    const preferredIp = localIps.find(i => i.ip.startsWith('192.168.4.') || i.ip.startsWith('192.168.') || i.ip.startsWith('10.') || i.ip.startsWith('172.')) || localIps[0] || { ip: 'localhost' };
    const primaryUrl = `http://${preferredIp.ip}:${PORT}`;
    const wifiChatUrl = `${primaryUrl}/chat`;
    const publicTunnelUrl = 'https://curvy-olives-know.loca.lt';
    const publicChatUrl = `${publicTunnelUrl}/chat`;

    res.json({
      port: PORT,
      localhost: {
        dashboard: `http://localhost:${PORT}`,
        chat: `http://localhost:${PORT}/chat`,
        widgetDemo: `http://localhost:${PORT}/widget-demo`
      },
      phoneAccess: {
        wifiUrl: wifiChatUrl,
        wifiQrCode: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(wifiChatUrl)}`,
        publicUrl: publicChatUrl,
        publicQrCode: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(publicChatUrl)}`,
        tunnelPassword: '103.239.37.158'
      },
      networkIps: localIps,
      primaryNetworkUrl: primaryUrl,
      embedSnippet: `<script src="${primaryUrl}/widget.js" data-title="Veritas AI"></script>`,
      iframeSnippet: `<iframe src="${primaryUrl}/chat" width="420" height="650" style="border:none;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.3);"></iframe>`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Server Start (Listens on 0.0.0.0 for LAN & Multi-User Access)
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 Veritas-Pro Enterprise AI Agentic Engine Running!`);
  console.log(`🌐 Admin Dashboard: http://localhost:${PORT}`);
  console.log(`📱 Public Chatbot for Users: http://localhost:${PORT}/chat`);
  console.log(`🧩 Embeddable Widget Demo: http://localhost:${PORT}/widget-demo`);
  console.log(`💾 SQLite WAL Database: Connected & Synchronized`);
  console.log(`🛠️  Autonomous Tools: 8 Active Deterministic Sandboxes`);
  console.log(`🔑 Key Attachment: Ready via Web UI Settings or .env`);
  console.log(`=======================================================`);
});

module.exports = app;
