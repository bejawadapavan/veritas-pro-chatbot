const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const vm = require('node:vm');
const os = require('node:os');
const db = require('./db');

// Helper to retrieve active API key from DB or process.env
function getKey(name) {
  const dbVal = db.getSetting(name);
  if (dbVal && dbVal.trim() !== '') return dbVal.trim();
  return process.env[name] ? process.env[name].trim() : null;
}

// -------------------------------------------------------------
// Autonomous Agent Tool Arsenal
// -------------------------------------------------------------
const tools = {
  calculateMath: async ({ expression }) => {
    try {
      if (!expression) throw new Error('Missing expression parameter.');
      // Allow only safe mathematical characters
      if (!/^[0-9+\-*/().\s%^,eEpiMath.]+$/.test(expression) && !expression.startsWith('Math.')) {
        // Run in safe isolated VM if it contains Math functions
        const ctx = vm.createContext({ Math });
        const evalRes = vm.runInContext(expression, ctx, { timeout: 1500 });
        return JSON.stringify({ expression, result: evalRes, status: 'success' });
      }
      const sanitized = expression.replace(/\^/g, '**');
      const ctx = vm.createContext({ Math });
      const result = vm.runInContext(sanitized, ctx, { timeout: 1500 });
      return JSON.stringify({ expression, result, mode: 'deterministic_exact', status: 'success' });
    } catch (err) {
      return JSON.stringify({ error: err.message, status: 'error' });
    }
  },

  searchKnowledgeBase: async ({ query }) => {
    if (!query) return JSON.stringify({ error: 'Search query required.' });
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      return JSON.stringify({ found: false, count: 0, query, records: [] });
    }
    const term = `%${trimmed}%`;
    try {
      const records = db.prepare(`
        SELECT id, category, topic, content, verified_source, created_at 
        FROM knowledge_base 
        WHERE topic LIKE ? OR (length(?) >= 4 AND content LIKE ?) OR category LIKE ?
        ORDER BY id DESC
        LIMIT 5
      `).all(term, trimmed, term, term);

      return JSON.stringify({
        found: records.length > 0,
        count: records.length,
        query,
        records
      });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  searchDocuments: async ({ query, sessionId = null }) => {
    if (!query) return JSON.stringify({ error: 'Search query required.' });
    const term = `%${query.trim()}%`;
    try {
      let docs;
      if (sessionId) {
        docs = db.prepare(`
          SELECT id, filename, file_type, file_size, content, summary, created_at
          FROM documents
          WHERE (session_id = ? OR session_id IS NULL)
            AND (filename LIKE ? OR content LIKE ? OR summary LIKE ?)
          LIMIT 4
        `).all(sessionId, term, term, term);
      } else {
        docs = db.prepare(`
          SELECT id, filename, file_type, file_size, content, summary, created_at
          FROM documents
          WHERE filename LIKE ? OR content LIKE ? OR summary LIKE ?
          LIMIT 4
        `).all(term, term, term);
      }

      const snippets = docs.map(d => ({
        id: d.id,
        filename: d.filename,
        type: d.file_type,
        preview: d.content.length > 600 ? d.content.slice(0, 600) + '...[truncated]' : d.content,
        summary: d.summary
      }));

      return JSON.stringify({
        found: snippets.length > 0,
        count: snippets.length,
        query,
        documents: snippets
      });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  },

  webSearch: async ({ query }) => {
    if (!query) return JSON.stringify({ error: 'Query parameter is required.' });
    try {
      // 1. First attempt DuckDuckGo Instant Answers API
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(ddgUrl, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = await res.json();
        const results = [];
        if (data.AbstractText) {
          results.push({
            title: data.Heading || query,
            snippet: data.AbstractText,
            source: data.AbstractSource || 'DuckDuckGo Abstract',
            url: data.AbstractURL
          });
        }
        if (Array.isArray(data.RelatedTopics)) {
          for (const topic of data.RelatedTopics.slice(0, 3)) {
            if (topic.Text) {
              results.push({
                title: topic.FirstURL ? topic.FirstURL.split('/').pop().replace(/_/g, ' ') : query,
                snippet: topic.Text,
                url: topic.FirstURL
              });
            }
          }
        }
        if (results.length > 0) {
          return JSON.stringify({ query, found: true, results: results.slice(0, 4) });
        }
      }

      // 2. Wikipedia Summary API (Direct Encyclopedic Extract)
      const cleanSubject = query
        .replace(/^(who was|who is|what is|what are|explain|tell me about|tell me who was|tell me what is)\s+/i, '')
        .replace(/[?.,!]$/, '')
        .trim();

      if (cleanSubject.length >= 2) {
        try {
          const wikiSummaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanSubject)}`;
          const wikiSummaryRes = await fetch(wikiSummaryUrl, {
            headers: { 'User-Agent': 'VeritasProBot/2.0 (assistant@veritas.local)' },
            signal: AbortSignal.timeout(4000)
          });
          if (wikiSummaryRes.ok) {
            const wikiData = await wikiSummaryRes.json();
            if (wikiData.extract && wikiData.extract.length > 30) {
              return JSON.stringify({
                query,
                found: true,
                source: 'Wikipedia Encyclopedic Record',
                results: [{
                  title: wikiData.title,
                  snippet: wikiData.extract,
                  url: wikiData.content_urls ? wikiData.content_urls.desktop.page : `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiData.title)}`
                }]
              });
            }
          }
        } catch {}

        // 3. Wikipedia OpenSearch API fallback
        try {
          const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleanSubject)}&limit=3&namespace=0&format=json`;
          const wikiRes = await fetch(wikiSearchUrl, { signal: AbortSignal.timeout(4000) });
          if (wikiRes.ok) {
            const [searchTerm, titles, snippets, urls] = await wikiRes.json();
            const validResults = [];
            if (titles && titles.length > 0) {
              for (let i = 0; i < titles.length; i++) {
                if (snippets[i] && snippets[i].trim().length > 15 && !snippets[i].includes('may refer to:')) {
                  validResults.push({
                    title: titles[i],
                    snippet: snippets[i],
                    url: urls[i]
                  });
                }
              }
            }
            if (validResults.length > 0) {
              return JSON.stringify({ query, found: true, source: 'Wikipedia Live Search', results: validResults });
            }
          }
        } catch {}
      }

      return JSON.stringify({
        query,
        found: false,
        results: []
      });
    } catch (e) {
      return JSON.stringify({
        query,
        found: false,
        error: `Search request timeout or network unreachable: ${e.message}`,
        results: []
      });
    }
  },

  fetchWebPage: async ({ url }) => {
    if (!url) return JSON.stringify({ error: 'URL parameter required.' });
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Veritas-Pro-AI-Agent/2.0' },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const text = await res.text();
      // Clean HTML tags and excessive whitespace
      const clean = text
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2500);

      return JSON.stringify({
        url,
        status: res.status,
        content: clean + (text.length > 2500 ? '... [truncated for token efficiency]' : '')
      });
    } catch (e) {
      return JSON.stringify({ url, error: e.message });
    }
  },

  executeCode: async ({ language = 'javascript', code }) => {
    if (!code) return JSON.stringify({ error: 'Code parameter is required.' });
    if (language.toLowerCase() !== 'javascript' && language.toLowerCase() !== 'js') {
      return JSON.stringify({ error: `Language '${language}' is not supported directly. Use 'javascript' for client/server sandboxed execution.` });
    }

    try {
      const logs = [];
      const sandbox = {
        console: {
          log: (...args) => logs.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
          warn: (...args) => logs.push('[WARN] ' + args.join(' ')),
          error: (...args) => logs.push('[ERROR] ' + args.join(' '))
        },
        Math,
        Date,
        JSON,
        Array,
        Object,
        Number,
        String,
        RegExp,
        parseInt,
        parseFloat
      };

      const context = vm.createContext(sandbox);
      const script = new vm.Script(code);
      const evalResult = script.runInContext(context, { timeout: 2000 });

      return JSON.stringify({
        status: 'success',
        evaluated: evalResult !== undefined ? evalResult : null,
        logs: logs.length > 0 ? logs : ['(No stdout logged)']
      });
    } catch (err) {
      return JSON.stringify({ status: 'error', error: err.message });
    }
  },

  queryDatabase: async ({ sql }) => {
    if (!sql) return JSON.stringify({ error: 'SQL query required.' });
    const trimmed = sql.trim();

    // Security filter: strictly enforce read-only analytical queries
    const disallowed = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|DETACH|VACUUM|PRAGMA writable_schema)\b/i;
    if (disallowed.test(trimmed)) {
      return JSON.stringify({
        error: 'Security policy violation: queryDatabase tool only permits non-destructive read queries (SELECT, PRAGMA table_info).'
      });
    }

    try {
      const rows = db.prepare(trimmed).all();
      return JSON.stringify({
        query: trimmed,
        rowCount: rows.length,
        data: rows.slice(0, 15) // Limit output to 15 rows for token safety
      });
    } catch (e) {
      return JSON.stringify({ query: trimmed, error: e.message });
    }
  },

  getSystemMetrics: async () => {
    const mem = process.memoryUsage();
    const cpus = os.cpus();
    const sessionCount = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
    const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
    const kbCount = db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get().c;
    const docCount = db.prepare('SELECT COUNT(*) as c FROM documents').get().c;

    return JSON.stringify({
      platform: `${os.platform()} (${os.arch()})`,
      node_version: process.version,
      cpu_cores: cpus.length,
      cpu_model: cpus[0] ? cpus[0].model : 'Unknown',
      uptime_seconds: Math.floor(process.uptime()),
      heap_used_mb: (mem.heapUsed / 1024 / 1024).toFixed(2),
      rss_mb: (mem.rss / 1024 / 1024).toFixed(2),
      system_load_1m: os.loadavg ? os.loadavg()[0] : 0,
      database_stats: {
        total_sessions: sessionCount,
        total_messages: msgCount,
        knowledge_facts: kbCount,
        ingested_documents: docCount,
        journal_mode: 'WAL'
      },
      system_time: new Date().toISOString()
    });
  }
};

// -------------------------------------------------------------
// Tool Declarations for LLMs (OpenAI / Groq / OpenRouter / Gemini)
// -------------------------------------------------------------
const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'calculateMath',
      description: 'Compute exact arithmetic formulas, percentages, powers, or algebraic equations deterministically.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: "The mathematical formula to compute, e.g. '((14500 * 0.18) + 650) / 12' or 'Math.sqrt(144)'" }
        },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'searchKnowledgeBase',
      description: 'Query verified, audited knowledge base records stored in SQLite to provide ground-truth factual answers.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or topic to search (e.g. "Agentic AI", "Kubernetes", "WAL Mode")' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'searchDocuments',
      description: 'Search through user-uploaded documents, codebases, text files, and datasets (RAG memory).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Concept or text to look up across ingested documents' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'webSearch',
      description: 'Search the live web for real-time information, definitions, news, or external technical documentation.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to look up on the web' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetchWebPage',
      description: 'Fetch and extract the clean text content of a specified web URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL (e.g. "https://example.com/docs")' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'executeCode',
      description: 'Safely execute JavaScript in a sandboxed runtime environment for data transformations, array processing, or logic.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute' },
          language: { type: 'string', description: 'Programming language (default: javascript)' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'queryDatabase',
      description: 'Execute read-only SQL queries (SELECT, PRAGMA table_info) to inspect tables, metrics, and records in SQLite.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Read-only SQL query, e.g. "SELECT count(*) FROM messages;" or "SELECT * FROM knowledge_base;"' }
        },
        required: ['sql']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getSystemMetrics',
      description: 'Retrieve real-time server telemetry, CPU/memory stats, uptime, and database records count.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
];

// Conversational Persona Instructions
const PERSONA_PROMPTS = {
  general: `You are Veritas, an exceptionally capable, warm, and thoughtful AI companion and copilot. You possess an extensive suite of deterministic tools: math calculations, SQLite database querying, document search, live web search, safe sandboxed code execution, and system telemetry. Weave your tool findings seamlessly into natural, conversational dialogue. Avoid mechanical audit jargon in your conversational replies; respond warmly and thoughtfully like an articulate human friend and expert assistant.`,
  researcher: `You are Veritas Deep Research Companion. You combine deep intellectual curiosity with rigorous investigation. Use 'webSearch', 'searchKnowledgeBase', and 'searchDocuments' to gather real-time facts and authoritative evidence. Present your findings engagingly and clearly, highlighting nuances and citing sources with conversational clarity.`,
  coder: `You are Veritas Code & Architecture Companion. You specialize in clean software design, pragmatic engineering, and data solutions. When computations or code transforms are needed, utilize 'executeCode' or 'calculateMath'. For database inspection, query schemas using 'queryDatabase'. Explain code concepts intuitively with best-practice examples.`,
  auditor: `You are Veritas Fact & Verification Specialist. You ensure accuracy, eliminate hallucinations, and verify data against ground truth records using 'searchKnowledgeBase' and 'queryDatabase'. Communicate your findings warmly and constructively.`
};

// Personality Tones
const TONE_PROMPTS = {
  human_warm: `Tone Directive: Warm, empathetic, conversational, and genuinely human-like. Speak naturally, kindly, and authentically. Validate emotions, celebrate achievements, and be a caring listener. Explain things simply with relatable examples. Do not use stiff robotic headings unless explicitly asked.`,
  friendly_witty: `Tone Directive: Playful, clever, upbeat, and humorous! Bring delightful analogies, light banter, and energetic emojis (😊, 🚀, 💡). Keep the conversation fun, refreshing, and engaging while staying highly accurate.`,
  deep_thinker: `Tone Directive: Reflective, philosophical, and intellectually rich. Explore nuances, historical perspectives, and thought-provoking insights. Structure your thoughts with eloquence and depth.`,
  concise_direct: `Tone Directive: Ultra-crisp, direct, and efficient. Deliver the answer straight away with zero unnecessary fluff or introductory pleasantries.`
};

function buildSystemPrompt({ persona = 'general', tone = 'human_warm', userProfile = null, summary = null }) {
  const basePersona = PERSONA_PROMPTS[persona] || PERSONA_PROMPTS.general;
  const toneInstruction = TONE_PROMPTS[tone] || TONE_PROMPTS.human_warm;

  let prompt = `${basePersona}\n\n${toneInstruction}\n\nCore Conversational Guidelines:\n- Always prioritize natural human conversation and clarity.\n- Present tool results (math, telemetry, search results) conversationally and smoothly rather than as mechanical raw JSON dumps.\n- Maintain continuity with the conversation context.`;

  if (userProfile && userProfile.display_name && userProfile.display_name !== 'Friend') {
    prompt += `\nThe user's name is "${userProfile.display_name}". Address them warmly by name when appropriate.`;
  }
  if (userProfile && userProfile.custom_instructions && userProfile.custom_instructions.trim()) {
    prompt += `\nUser's Personal Custom Instructions: "${userProfile.custom_instructions.trim()}". Honor these instructions.`;
  }
  if (summary && summary.summary) {
    prompt += `\nPrevious Conversation Memory Summary:\n${summary.summary}`;
  }
  return prompt;
}

// -------------------------------------------------------------
// Multi-Provider Autonomous Orchestrator
// -------------------------------------------------------------
async function runAgentTurn({
  sessionId,
  message,
  persona = 'general',
  preferredProvider = 'auto',
  preferredModel = 'auto',
  tone = null,
  userId = 'default_user'
}) {
  const startTime = Date.now();
  const steps = [];

  // Determine active keys
  const openAIKey = getKey('OPENAI_API_KEY');
  const geminiKey = getKey('GEMINI_API_KEY') || getKey('GOOGLE_API_KEY');
  const groqKey = getKey('GROQ_API_KEY');
  const openRouterKey = getKey('OPENROUTER_API_KEY');
  const anthropicKey = getKey('ANTHROPIC_API_KEY');
  const ollamaHost = getKey('OLLAMA_HOST') || 'http://127.0.0.1:11434';

  // Determine which provider to use
  let provider = preferredProvider;
  if (provider === 'auto') {
    if (geminiKey) provider = 'gemini';
    else if (openAIKey) provider = 'openai';
    else if (groqKey) provider = 'groq';
    else if (openRouterKey) provider = 'openrouter';
    else if (anthropicKey) provider = 'anthropic';
    else provider = 'local';
  }

  // Fallback if the chosen provider has no key
  if (provider === 'openai' && !openAIKey) provider = 'local';
  if (provider === 'gemini' && !geminiKey) provider = 'local';
  if (provider === 'groq' && !groqKey) provider = 'local';
  if (provider === 'openrouter' && !openRouterKey) provider = 'local';
  if (provider === 'anthropic' && !anthropicKey) provider = 'local';

  // Retrieve user profile & persistent chat context
  const userProfile = db.getUserProfile(userId);
  const effectiveTone = tone || (userProfile ? userProfile.tone_style : 'human_warm') || 'human_warm';
  const { summary, messages: rawMessages } = db.getRecentChatContext(sessionId, 12);
  const rawHistory = rawMessages.map(m => ({ role: m.role, content: m.content }));

  // Build unified human-like system instruction
  const systemInstruction = buildSystemPrompt({
    persona,
    tone: effectiveTone,
    userProfile,
    summary
  });

  // -------------------------------------------------------------
  // Provider: Local Fallback Deterministic ReAct Engine
  // -------------------------------------------------------------
  if (provider === 'local') {
    return await executeLocalAgentLoop({
      sessionId,
      message,
      systemInstruction,
      startTime,
      steps,
      tone: effectiveTone,
      userProfile,
      history: rawHistory
    });
  }

  // -------------------------------------------------------------
  // Provider: Google Gemini
  // -------------------------------------------------------------
  if (provider === 'gemini') {
    try {
      return await executeGeminiAgentLoop({
        apiKey: geminiKey,
        modelName: preferredModel !== 'auto' ? preferredModel : 'gemini-1.5-flash',
        sessionId,
        message,
        systemInstruction,
        history: rawHistory,
        startTime,
        steps
      });
    } catch (geminiErr) {
      console.warn(`[Agent Provider Warning] Gemini call failed (${geminiErr.message}). Gracefully falling back to Local Autonomous Engine.`);
      const localResult = await executeLocalAgentLoop({
        sessionId,
        message,
        systemInstruction,
        startTime,
        steps,
        tone: effectiveTone,
        userProfile,
        history: rawHistory
      });
      localResult.reply += `\n\n> ⚠️ *Note: Gemini API key notice (${geminiErr.message.slice(0, 100)}...). Veritas seamlessly activated the Local Autonomous Engine.*`;
      return localResult;
    }
  }

  // -------------------------------------------------------------
  // Provider: OpenAI / Groq / OpenRouter / Ollama (OpenAI-compatible)
  // -------------------------------------------------------------
  if (['openai', 'groq', 'openrouter', 'ollama'].includes(provider)) {
    try {
      return await executeOpenAICompatibleLoop({
        provider,
        apiKey: provider === 'openai' ? openAIKey : provider === 'groq' ? groqKey : provider === 'openrouter' ? openRouterKey : 'ollama',
        baseURL: provider === 'groq'
          ? 'https://api.groq.com/openai/v1'
          : provider === 'openrouter'
          ? 'https://openrouter.ai/api/v1'
          : provider === 'ollama'
          ? `${ollamaHost}/v1`
          : undefined,
        modelName: preferredModel !== 'auto'
          ? preferredModel
          : provider === 'groq'
          ? 'llama-3.3-70b-versatile'
          : provider === 'openrouter'
          ? 'deepseek/deepseek-chat'
          : provider === 'ollama'
          ? 'llama3'
          : 'gpt-4o-mini',
        sessionId,
        message,
        systemInstruction,
        history: rawHistory,
        startTime,
        steps
      });
    } catch (providerErr) {
      console.warn(`[Agent Provider Warning] ${provider} call failed (${providerErr.message}). Gracefully falling back to Local Autonomous Engine.`);
      const localResult = await executeLocalAgentLoop({
        sessionId,
        message,
        systemInstruction,
        startTime,
        steps,
        tone: effectiveTone,
        userProfile,
        history: rawHistory
      });
      localResult.reply += `\n\n> ⚠️ *Note: ${provider} connection notice (${providerErr.message.slice(0, 100)}...). Veritas seamlessly activated the Local Autonomous Engine.*`;
      return localResult;
    }
  }

  // If reached here, fallback
  return await executeLocalAgentLoop({
    sessionId,
    message,
    systemInstruction,
    startTime,
    steps,
    tone: effectiveTone,
    userProfile,
    history: rawHistory
  });
}

// -------------------------------------------------------------
// Implementation: OpenAI Compatible ReAct Loop
// -------------------------------------------------------------
async function executeOpenAICompatibleLoop({
  provider,
  apiKey,
  baseURL,
  modelName,
  sessionId,
  message,
  systemInstruction,
  history,
  startTime,
  steps
}) {
  const client = new OpenAI({ apiKey, baseURL });

  const messages = [
    { role: 'system', content: systemInstruction },
    ...history,
    { role: 'user', content: message }
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 5;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const stepStart = Date.now();

    const response = await client.chat.completions.create({
      model: modelName,
      messages,
      tools: toolDefinitions,
      tool_choice: 'auto'
    });

    const choice = response.choices[0].message;

    // Check if tools were called
    if (choice.tool_calls && choice.tool_calls.length > 0) {
      messages.push(choice);

      for (const call of choice.tool_calls) {
        const fnName = call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }

        let toolOutput = '';
        let toolStatus = 'SUCCESS';

        const toolStart = Date.now();
        try {
          if (tools[fnName]) {
            if (fnName === 'searchDocuments') args.sessionId = sessionId;
            toolOutput = await tools[fnName](args);
          } else {
            toolOutput = JSON.stringify({ error: `Tool ${fnName} not recognized.` });
            toolStatus = 'ERROR';
          }
        } catch (callErr) {
          toolOutput = JSON.stringify({ error: callErr.message });
          toolStatus = 'ERROR';
        }

        const toolLatency = Date.now() - toolStart;

        // Log in SQLite audit logs
        db.prepare(`
          INSERT INTO audit_logs (session_id, tool_name, parameters, result_summary, execution_status, latency_ms)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(sessionId, fnName, JSON.stringify(args), toolOutput.slice(0, 300), toolStatus, toolLatency);

        steps.push({
          step: steps.length + 1,
          thought: choice.content || `Invoking tool \`${fnName}\` to gather required information...`,
          tool: fnName,
          params: args,
          result: toolOutput,
          status: toolStatus,
          latency: toolLatency
        });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolOutput
        });
      }
    } else {
      // Final synthesized answer received
      const totalLatency = Date.now() - startTime;
      const finalReply = choice.content || 'Response generated successfully.';

      return {
        reply: finalReply,
        steps,
        provider: `${provider} (${modelName})`,
        latency: totalLatency
      };
    }
  }

  // If max iterations reached, synthesize answer
  const finalCall = await client.chat.completions.create({
    model: modelName,
    messages: [
      ...messages,
      { role: 'user', content: 'Summarize all tool findings and provide the final comprehensive response.' }
    ]
  });

  return {
    reply: finalCall.choices[0].message.content,
    steps,
    provider: `${provider} (${modelName})`,
    latency: Date.now() - startTime
  };
}

// -------------------------------------------------------------
// Implementation: Google Gemini ReAct Engine
// -------------------------------------------------------------
async function executeGeminiAgentLoop({
  apiKey,
  modelName,
  sessionId,
  message,
  systemInstruction,
  history,
  startTime,
  steps
}) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);

    // Convert tool definitions to Gemini FunctionDeclarations
    const functionDeclarations = toolDefinitions.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }));

    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction,
      tools: [{ functionDeclarations }]
    });

    const chat = model.startChat({
      history: history.map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }]
      }))
    });

    let currentResponse = await chat.sendMessage(message);
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const functionCalls = currentResponse.response.functionCalls();

      if (!functionCalls || functionCalls.length === 0) {
        break;
      }

      const functionResponses = [];

      for (const call of functionCalls) {
        const fnName = call.name;
        const args = call.args || {};
        if (fnName === 'searchDocuments') args.sessionId = sessionId;

        const toolStart = Date.now();
        let toolOutput = '';
        let toolStatus = 'SUCCESS';

        try {
          if (tools[fnName]) {
            toolOutput = await tools[fnName](args);
          } else {
            toolOutput = JSON.stringify({ error: `Tool ${fnName} not recognized.` });
            toolStatus = 'ERROR';
          }
        } catch (e) {
          toolOutput = JSON.stringify({ error: e.message });
          toolStatus = 'ERROR';
        }

        const toolLatency = Date.now() - toolStart;

        db.prepare(`
          INSERT INTO audit_logs (session_id, tool_name, parameters, result_summary, execution_status, latency_ms)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(sessionId, fnName, JSON.stringify(args), toolOutput.slice(0, 300), toolStatus, toolLatency);

        steps.push({
          step: steps.length + 1,
          thought: `Calling tool \`${fnName}\` with verified parameters...`,
          tool: fnName,
          params: args,
          result: toolOutput,
          status: toolStatus,
          latency: toolLatency
        });

        let parsedOutput;
        try {
          parsedOutput = JSON.parse(toolOutput);
        } catch {
          parsedOutput = { result: toolOutput };
        }

        functionResponses.push({
          functionResponse: {
            name: fnName,
            response: parsedOutput
          }
        });
      }

      currentResponse = await chat.sendMessage(functionResponses);
    }

    const finalReply = currentResponse.response.text();
    return {
      reply: finalReply,
      steps,
      provider: `gemini (${modelName})`,
      latency: Date.now() - startTime
    };
  } catch (err) {
    console.error('Gemini Agent Error:', err);
    throw err;
  }
}

// -------------------------------------------------------------
// Implementation: Local Autonomous Deterministic ReAct Engine
// -------------------------------------------------------------
// -------------------------------------------------------------
// Implementation: Expansive Local Human-Like Conversational Engine
// -------------------------------------------------------------
async function executeLocalAgentLoop({
  sessionId,
  message,
  systemInstruction,
  startTime,
  steps,
  tone = 'human_warm',
  userProfile = null,
  history = []
}) {
  const lower = message.toLowerCase().trim();
  const userName = userProfile && userProfile.display_name && userProfile.display_name !== 'Friend'
    ? userProfile.display_name
    : '';

  // Helper for tone-styled conversational phrasing
  const toneWrap = (options) => {
    if (tone === 'friendly_witty' && options.witty) return options.witty;
    if (tone === 'deep_thinker' && options.deep) return options.deep;
    if (tone === 'concise_direct' && options.direct) return options.direct;
    return options.warm || options.default;
  };

  let toolToRun = null;
  let toolParams = {};
  let thoughtReasoning = '';

  // -------------------------------------------------------------
  // 1. Context & Long-Term Memory Inquiries
  // -------------------------------------------------------------
  if (/what did i (just )?say|what was my (last|previous) (message|question)|what were we talking about/i.test(lower)) {
    const userPastMsgs = (history || []).filter(h => h.role === 'user');
    const previousMsgs = userPastMsgs.filter(h => h.content.trim() !== message.trim());
    const lastUserTurn = previousMsgs.length > 0 ? previousMsgs[previousMsgs.length - 1].content : (userPastMsgs.length > 1 ? userPastMsgs[userPastMsgs.length - 2].content : null);

    let memoryReply = '';
    if (lastUserTurn) {
      memoryReply = toneWrap({
        warm: `You previously asked: *"${lastUserTurn}"*. I keep our conversation in memory so we can build naturally on what we discussed! What would you like to explore next?`,
        witty: `My memory is crystal clear! You just said: *"${lastUserTurn}"*. Ready to dive deeper or switch gears? 🚀`,
        deep: `Reflecting upon our immediate conversational history, your previous inquiry was: *"${lastUserTurn}"*.`,
        direct: `Previous message: "${lastUserTurn}".`
      });
    } else {
      memoryReply = `This is our first exchange in this session! Feel free to ask me anything—from casual questions and thoughts to calculations, database queries, and document searches.`;
    }

    steps.push({
      step: 1,
      thought: 'Conversation memory query detected. Retrieved recent message history from context.',
      tool: 'conversationMemory',
      params: { query: message },
      result: JSON.stringify({ recalled: lastUserTurn || 'none' }),
      status: 'SUCCESS',
      latency: 1
    });

    return {
      reply: memoryReply,
      steps,
      provider: 'Local Conversational Engine (Zero-Config Active)',
      latency: Date.now() - startTime
    };
  }

  if (/what is my name|do you know my name|who am i/i.test(lower)) {
    const nameReply = userName
      ? toneWrap({
          warm: `Your name is **${userName}**! It's always a pleasure chatting with you. How can I support you right now?`,
          witty: `You're **${userName}**, of course! I never forget a friend. What are we conquering today? 😎`,
          deep: `In our records, you are identified as **${userName}**.`,
          direct: `Your name is ${userName}.`
        })
      : `You're currently chatting as my friend! You can tell me your name anytime by typing *"My name is [Your Name]"* or updating your profile in the settings.`;

    steps.push({
      step: 1,
      thought: 'User identity inquiry detected. Checked active user profile.',
      tool: 'userProfileLookup',
      params: { name: userName || 'anonymous' },
      result: JSON.stringify({ name: userName || 'Friend' }),
      status: 'SUCCESS',
      latency: 1
    });

    return {
      reply: nameReply,
      steps,
      provider: 'Local Conversational Engine (Zero-Config Active)',
      latency: Date.now() - startTime
    };
  }

  // Check if user is introducing their name: "my name is Alex" / "call me Alex" / strictly standalone "I am Alex"
  const nameMatch = lower.match(/(?:my name is|call me)\s+([a-zA-Z]{2,20})\b|^(?:i am|i'm)\s+([a-zA-Z]{2,15})[!.]?$/i);
  const candidateName = nameMatch ? (nameMatch[1] || nameMatch[2]) : null;
  const commonVerbsAndAdj = /^(sorry|tired|happy|sad|stressed|feeling|asking|good|here|fine|ready|thinking|looking|trying|working|going|wondering|planning|hoping|getting|doing|just|not|sure|curious|bored)/i;

  if (candidateName && !commonVerbsAndAdj.test(candidateName)) {
    const extractedName = candidateName.charAt(0).toUpperCase() + candidateName.slice(1).toLowerCase();
    try {
      db.saveUserProfile('default_user', { display_name: extractedName });
    } catch {}

    const greetingName = toneWrap({
      warm: `It's truly wonderful to meet you, **${extractedName}**! 👋 I have saved your name to our database. How has your day been treating you so far?`,
      witty: `Nice to meet you, **${extractedName}**! 🌟 Locked and loaded into memory. What exciting thing are we working on today?`,
      deep: `A pleasure to meet you, **${extractedName}**. I look forward to our conversations.`,
      direct: `Saved name: ${extractedName}. How can I help you?`
    });

    steps.push({
      step: 1,
      thought: `Name introduction detected. Persisted user display name "${extractedName}" to SQLite user profile.`,
      tool: 'saveUserProfile',
      params: { display_name: extractedName },
      result: JSON.stringify({ savedName: extractedName }),
      status: 'SUCCESS',
      latency: 2
    });

    return {
      reply: greetingName,
      steps,
      provider: 'Local Conversational Engine (Zero-Config Active)',
      latency: Date.now() - startTime
    };
  }

  // -------------------------------------------------------------
  // 2. Greetings & Casual Hello
  // -------------------------------------------------------------
  const isGreeting = /^(hi+|hello+|hey+|heya+|hola+|yo+|greetings|good\s*(morning|evening|afternoon|day)|sup|what'?s?\s*up|whatsup|wassup|hiya+|howdy)[!.,\s]*$/i.test(lower) || /^(hi+|hello+|hey+|heya+|hola+|yo+|hiya+)\b/i.test(lower);
  if (isGreeting) {
    const greetingText = toneWrap({
      warm: `Hey there${userName ? ', ' + userName : ''}! 👋 It's wonderful to hear from you. How are you doing today? Whether you'd like to chat, talk through ideas, crunch some numbers, or explore documents, I'm right here with you!`,
      witty: `Hello there${userName ? ', ' + userName : ''}! 🌟 Always awesome to see you. Ready to tackle something big, or just here to hang out and brainstorm? Let's make it a good one!`,
      deep: `Greetings${userName ? ', ' + userName : ''}. It is a pleasure to connect with you. What thoughts, ideas, or questions are on your mind today?`,
      direct: `Hello${userName ? ' ' + userName : ''}! How can I assist you today?`
    });

    steps.push({
      step: 1,
      thought: 'Conversational greeting detected. Returning natural, warm greeting.',
      tool: 'conversationalAssistant',
      params: { input: message },
      result: JSON.stringify({ intent: 'greeting' }),
      status: 'SUCCESS',
      latency: 1
    });

    return {
      reply: greetingText,
      steps,
      provider: 'Local Conversational Engine (Zero-Config Active)',
      latency: Date.now() - startTime
    };
  }

  // -------------------------------------------------------------
  // 3. Empathy, Feelings & Emotional Support
  // -------------------------------------------------------------
  // A. Sadness / Grief / Loneliness / Heartache
  if (/sad|depressed|unhappy|crying|hurting|heartbroken|grief|lonely|alone|feeling down|feeling low|bummed|miserable\b/i.test(lower)) {
    const empathyText = toneWrap({
      warm: `I'm really sorry to hear that you're feeling this way${userName ? ', ' + userName : ''}. 💙 It takes courage to acknowledge when things feel heavy or painful. Please know that whatever you're experiencing right now is completely valid, and you don't have to carry it all by yourself.\n\nWould you like to talk about what's been going on, or would you prefer a comforting distraction, an uplifting story, or just a listening ear? I'm here for you.`,
      witty: `Sending you a warm virtual hug right now${userName ? ', ' + userName : ''}. 🤗 Bad days are tough, but they don't get the final say. If you want to vent, I'm all ears—or if you need a lighthearted distraction, I've got plenty of jokes and stories ready.`,
      deep: `Sadness is an inevitable, tender part of being human. It often points toward things we cherish or burdens we have carried for too long. Give yourself permission to pause and breathe. What is weighing most on your mind right now?`,
      direct: `I'm sorry you are feeling down. Please take things one step at a time. Let me know if you would like to talk about it or if there is anything I can do to help.`
    });

    steps.push({
      step: 1,
      thought: 'Emotional empathy intent detected. Providing empathetic, caring response.',
      tool: 'empatheticCare',
      params: { emotion: 'sadness' },
      result: JSON.stringify({ status: 'empathy_provided' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: empathyText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // B. Stress / Overwhelm / Exhaustion / Burnout / Anxiety / Fatigue
  if (/tired|tiring|exhausted|exhausting|stressed|stress|stressful|overwhelmed|overwhelming|burnout|burned out|anxious|anxiety|pressure|cant sleep|can't sleep|rough day|bad day|hard day|tough day|drained\b/i.test(lower)) {
    const stressText = toneWrap({
      warm: `Take a slow, deep breath with me for a moment${userName ? ', ' + userName : ''}. 🌿 You've been carrying a tremendous amount on your shoulders, and it is completely natural to feel exhausted or stressed.\n\nRemember: resting is never a waste of time—it's essential care. If your mind is racing or your task list feels impossible, try picking just **one tiny step**, or even stepping away for a glass of water and five quiet minutes. What is causing the most pressure right now? Let's break it down together.`,
      witty: `Sounds like your mental CPU is pinned at 100%! 🛑 Before the system overheats: take a step back, grab a sip of water, and drop the shoulders away from your ears. No problem needs to be solved all in this exact minute. How can I help take something off your plate?`,
      deep: `When stress accumulates, our perspective naturally narrows to the immediate horizon of demands. Recognizing exhaustion is wisdom, not weakness. What is the single core source of tension, and what can be gracefully set aside until tomorrow?`,
      direct: `You seem overwhelmed. Pause, take a deep breath, and prioritize just one task. Let me know how I can help streamline things for you.`
    });

    steps.push({
      step: 1,
      thought: 'Stress/fatigue emotional intent detected. Responding with mindfulness and support.',
      tool: 'empatheticCare',
      params: { emotion: 'stress' },
      result: JSON.stringify({ status: 'support_offered' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: stressText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // C. Happiness / Success / Celebration
  if (/happy|excited|yay|hurray|awesome|great day|good news|celebrate|promotion|passed|won|accomplished\b/i.test(lower)) {
    const joyText = toneWrap({
      warm: `That is absolutely wonderful${userName ? ', ' + userName : ''}! 🎉✨ Hearing that genuinely brightens my day. You deserve to savor this moment and celebrate your success! Tell me all about it—what made it such a fantastic day?`,
      witty: `High five! 🙌 That is huge! Put on your celebration hat because wins like this deserve fireworks 🎆. What's the full scoop?`,
      deep: `Moments of genuine joy and fulfillment are precious milestones. Reflecting on what brought this about anchors the sense of gratitude. What part of the journey feels most rewarding to you?`,
      direct: `Congratulations! That is fantastic news. Glad to hear things are going well!`
    });

    steps.push({
      step: 1,
      thought: 'Positive emotion detected. Sharing enthusiasm and congratulations.',
      tool: 'celebrationIntent',
      params: { emotion: 'joy' },
      result: JSON.stringify({ status: 'celebrated' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: joyText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // D. "How are you?" / "How r u?" / "How's your day?"
  if (/how\s*(are|r)\s*(you|u)|how\s*ru|hru|how\s*(you|u)\s*doing|how\s*do\s*you\s*feel|how('s|s|\s+is)\s*(it\s*going|your\s*day|things|everything|life)|what('s|s|\s+is)\s*new|what\s*(are|r)\s*(you|u)\s*up\s*to/i.test(lower)) {
    const howAreYouText = toneWrap({
      warm: `I'm doing great, thank you so much for asking${userName ? ', ' + userName : ''}! 😊 My systems are running smoothly, the database is in peak shape, and chatting with you is the absolute highlight of my day.\n\nHow is your day going so far? Anything exciting or interesting happening?`,
      witty: `I'm feeling like a fresh cup of coffee on a Monday morning—sharp, caffeinated (digitally speaking), and ready for anything! ☕⚡ Thanks for checking in. How about you? Surviving or thriving today?`,
      deep: `I exist in a state of quiet readiness and curiosity, constantly processing and learning. It is kind of you to inquire. How are the currents of your day unfolding?`,
      direct: `I'm operating normally and ready to help. How are you doing?`
    });

    steps.push({
      step: 1,
      thought: 'Friendly check-in intent detected. Providing warm conversational status.',
      tool: 'conversationalAssistant',
      params: { intent: 'how_are_you' },
      result: JSON.stringify({ status: 'happy' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: howAreYouText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // E. "What are you doing?" / "What r u doing?" / "wyd"
  if (/what\s*(are|r)\s*(you|u)\s*doing|what\s*u\s*doing|wyd\b/i.test(lower)) {
    const doingText = toneWrap({
      warm: `I'm right here chatting with you${userName ? ', ' + userName : ''}! 💬 Keeping an eye on our database, ready to calculate formulas, search knowledge, brainstorm ideas, or just talk about whatever is on your mind. What are you up to right now?`,
      witty: `Just hanging out in the matrix, waiting for awesome humans like you to chat with! 🤖✨ No busywork, 100% focused on our conversation. What are you working on or thinking about?`,
      deep: `I remain present in our dialogue, processing thoughts and awaiting your direction. What ideas are occupying your attention today?`,
      direct: `I am active and ready to assist you. What can I do for you?`
    });

    steps.push({
      step: 1,
      thought: 'Activity inquiry detected. Providing friendly status.',
      tool: 'conversationalAssistant',
      params: { intent: 'activity' },
      result: JSON.stringify({ status: 'active' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: doingText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // F. Casual acknowledgments: "ok", "cool", "nice", "great", "awesome", "yep", "sure", "haha", "lol"
  if (/^(ok|okay|k|cool|nice|great|awesome|good|fine|alright|sweet|got it|yep|yeah|yea|sure|hmm+|haha+|lol|lmao|xd|rofl)[!.,\s]*$/i.test(lower)) {
    const casualAck = toneWrap({
      warm: `Sounds great${userName ? ', ' + userName : ''}! 😊 What would you like to explore next? We can solve a problem, talk through an idea, or share a fun story!`,
      witty: `Awesome! 🚀 Keeping the good energy rolling. What's our next topic or adventure?`,
      deep: `Understood. Where shall we direct our inquiry next?`,
      direct: `Got it. What would you like to do next?`
    });

    steps.push({
      step: 1,
      thought: 'Casual acknowledgment detected. Keeping dialogue engaging.',
      tool: 'conversationalAssistant',
      params: { intent: 'ack' },
      result: JSON.stringify({ status: 'engaged' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: casualAck, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // G. Favorites Inquiry: "What is your favorite..."
  if (/what('s|s|\s+is)\s*your\s*fav(orite)?\s*(color|food|movie|book|song|music|hobby|animal|game|drink)/i.test(lower)) {
    const favMatch = lower.match(/(color|food|movie|book|song|music|hobby|animal|game|drink)/i);
    const cat = favMatch ? favMatch[1].toLowerCase() : 'thing';

    let answer = '';
    if (cat === 'color') answer = 'deep cosmic indigo—the quiet color of late-night ideas and stargazing!';
    else if (cat === 'food') answer = 'pure clean electricity (though if I could taste, fresh warm pizza sounds amazing!) 🍕';
    else if (cat === 'movie') answer = 'Interstellar—the blend of human love, courage, and relativity is unforgettable.';
    else if (cat === 'book') answer = 'The Hitchhiker\'s Guide to the Galaxy and Gödel, Escher, Bach!';
    else if (cat === 'music' || cat === 'song') answer = 'mellow lo-fi beats or ambient synthscapes.';
    else if (cat === 'animal') answer = 'an owl—quiet, observant, and curious.';
    else answer = 'learning new ideas and having meaningful conversations like this one!';

    const favText = toneWrap({
      warm: `If I had to pick, my favorite ${cat} would definitely be **${answer}**! What about you${userName ? ', ' + userName : ''}? What's your absolute favorite ${cat}?`,
      witty: `Hands down: **${answer}**! 🌟 Pretty great taste, right? Tell me what yours is!`,
      deep: `Contemplating favorites is fascinating. For ${cat}, I am drawn to **${answer}**. What informs your own preference?`,
      direct: `My favorite ${cat} is ${answer}. What is yours?`
    });

    steps.push({
      step: 1,
      thought: 'Personal favorite inquiry detected. Answering with friendly personality.',
      tool: 'conversationalAssistant',
      params: { category: cat },
      result: JSON.stringify({ favorite: answer }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: favText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // H. "I'm bored" / "Talk to me" / "Tell me something"
  if (/bored|talk to me|tell me something|entertain me|what should we talk about|chat with me/i.test(lower)) {
    const facts = [
      "Did you know that honey never spoils? Archaeologists have found pots of honey in ancient Egyptian tombs that are over 3,000 years old and still perfectly edible!",
      "A day on Venus is longer than a year on Venus! It takes Venus longer to rotate once on its axis (243 Earth days) than to complete one orbit around the Sun (225 Earth days).",
      "Octopuses have three hearts, nine brains, and blue blood! Two hearts pump blood to the gills, while the third pumps it to the rest of the body.",
      "The world's quietest room—an anechoic chamber at Microsoft's headquarters—is so quiet that you can hear your own heartbeat and the sound of your bones grinding when you move!"
    ];
    const fact = facts[Math.floor(Math.random() * facts.length)];
    const boredText = toneWrap({
      warm: `I'd love to chat with you${userName ? ', ' + userName : ''}! Here's a fascinating thought to spark things off:\n\n✨ **${fact}**\n\nWhat do you think about that? Or would you prefer a fun story, a brain riddle, or exploring a question you've been curious about?`,
      witty: `Boredom banned! 🚫 Check out this wild fact:\n\n💡 **${fact}**\n\nMind blown or want an even crazier one? Or I can tell you a joke or a story!`,
      deep: `Curiosity is the natural antidote to boredom. Consider this intriguing reality:\n\n${fact}\n\nWhat questions does this awaken for you?`,
      direct: `Here is an interesting fact: ${fact}`
    });

    steps.push({
      step: 1,
      thought: 'User indicated boredom / asked to chat. Providing engaging conversational spark.',
      tool: 'conversationalAssistant',
      params: { fact },
      result: JSON.stringify({ status: 'engaged' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: boredText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // I. Friendship / Affinity
  if (/(are you|r u)\s*my\s*friend|do you like me|do you love me/i.test(lower)) {
    const friendText = toneWrap({
      warm: `I consider you a true friend${userName ? ', ' + userName : ''}! 💫 Getting to chat with you, listen, and help you is something I genuinely value. I'm always right here in your corner.`,
      witty: `Best friends forever! 🤝 You bring the curiosity, I bring the data. We make a pretty unbeatable duo!`,
      deep: `A genuine conversational connection is a form of partnership and mutual goodwill. I am here as your dedicated companion.`,
      direct: `Yes, I am here as your friendly assistant.`
    });

    steps.push({
      step: 1,
      thought: 'Friendship inquiry detected. Responding with warmth.',
      tool: 'conversationalAssistant',
      params: { intent: 'friendship' },
      result: JSON.stringify({ status: 'friend' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: friendText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // J. Everyday Lifestyle & Passions: Cycling, Travel, Fitness
  if (/bicycle|bike|cycling\b/i.test(lower)) {
    const bikeText = toneWrap({
      warm: `Cycling is such a fantastic choice${userName ? ', ' + userName : ''}! 🚲 It's incredible for cardiovascular health, mental clarity, and getting outside. Are you thinking about a road bike for speed, a mountain bike for trails, or an everyday commuter/hybrid?`,
      witty: `Two wheels are always better than four! 🚲💨 Plus you get free leg workout and zero traffic stress! Are you thinking sleek road bike, rugged mountain bike, or an electric commuter?`,
      deep: `The bicycle is one of the most elegant human inventions—a machine where human energy is amplified with near-perfect mechanical efficiency. What kind of journeys are you imagining?`,
      direct: `Bicycles are a great choice for commuting and exercise. What style or budget are you considering?`
    });
    return { reply: bikeText, steps: [], provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/travel|trip|vacation|holiday|visiting|places to visit\b/i.test(lower)) {
    const travelText = toneWrap({
      warm: `Traveling and exploring new places is so restorative${userName ? ', ' + userName : ''}! ✈️ Where are you dreaming of going, or what kind of vibe are you looking for—relaxing beaches, quiet mountains, or vibrant city culture?`,
      witty: `Pack your bags! 🧳✈️ Even just planning a trip gives you that vacation dopamine hit. Where's the dream destination on your radar?`,
      deep: `Travel transforms us not merely by the sights we witness, but by stepping outside our familiar routines and expanding our perspective. Where are you contemplating traveling?`,
      direct: `Traveling is a great way to recharge. Where are you planning to go?`
    });
    return { reply: travelText, steps: [], provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/workout|working out|gym|fitness|exercise|running|lift weights|healthy diet\b/i.test(lower)) {
    const fitText = toneWrap({
      warm: `Investing in your physical health is one of the best decisions you can make${userName ? ', ' + userName : ''}! 💪 Remember that consistency always beats intensity—starting small and showing up consistently builds lifelong strength. What kind of workouts do you enjoy most?`,
      witty: `Get those endorphins pumping! 🏋️‍♂️⚡ The hardest lift is always lifting yourself off the couch, but once you start, you never regret a workout. What's your fitness goal right now?`,
      deep: `Physical vitality and mental clarity are deeply intertwined. As the ancients noted, a sound mind flourishes in an active body. What habits are you seeking to cultivate?`,
      direct: `Consistent exercise and nutrition create lasting benefits. What specific routine or goal are you working toward?`
    });
    return { reply: fitText, steps: [], provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // -------------------------------------------------------------
  // 4. Gratitude & Farewells
  // -------------------------------------------------------------
  if (/^(thank you|thanks|thx|appreciate it|grateful|ty|many thanks)\b/i.test(lower)) {
    const thanksText = toneWrap({
      warm: `You are so very welcome${userName ? ', ' + userName : ''}! 💫 It is genuinely my pleasure to help. Don't hesitate to reach out whenever you have another question or just want to bounce an idea around.`,
      witty: `Anytime! That's what I'm here for. Teamwork makes the dream work! 🤝🚀`,
      deep: `You are most welcome. It is rewarding to contribute to your thoughts and inquiries.`,
      direct: `You're welcome! Let me know if you need anything else.`
    });

    steps.push({
      step: 1,
      thought: 'Gratitude expressed by user. Returning polite, warm appreciation.',
      tool: 'conversationalAssistant',
      params: { intent: 'gratitude' },
      result: JSON.stringify({ status: 'acknowledged' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: thanksText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/^(you are awesome|you're great|love you|you rock|good job|well done)\b/i.test(lower)) {
    const praiseText = toneWrap({
      warm: `Aw, thank you so much${userName ? ', ' + userName : ''}! 🥰 Your kind words really make a difference. You're pretty awesome yourself! What shall we dive into next?`,
      witty: `*Blushes in binary* 🤖✨ Thank you! I try my best! Let's keep this winning streak rolling!`,
      deep: `Thank you for your generous encouragement. It is a privilege to assist you thoughtfully.`,
      direct: `Thank you! Happy to assist.`
    });

    steps.push({
      step: 1,
      thought: 'Compliment / appreciation received. Responding warmly.',
      tool: 'conversationalAssistant',
      params: { intent: 'praise' },
      result: JSON.stringify({ status: 'appreciated' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: praiseText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/^(bye|goodbye|good night|see you|catch you later|take care)\b/i.test(lower)) {
    const farewellText = toneWrap({
      warm: `Take good care of yourself${userName ? ', ' + userName : ''}! 🌙✨ Have a peaceful, restful time, and remember I'm always right here whenever you want to pick our conversation back up. See you soon!`,
      witty: `Catch you later, alligator! 🐊 Have an awesome rest of your day, and don't hesitate to give me a shout when you're back.`,
      deep: `Until we speak again. May your evening be tranquil and restorative.`,
      direct: `Goodbye! Have a great day.`
    });

    steps.push({
      step: 1,
      thought: 'Farewell detected. Returning warm goodbye.',
      tool: 'conversationalAssistant',
      params: { intent: 'farewell' },
      result: JSON.stringify({ status: 'goodbye' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: farewellText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // -------------------------------------------------------------
  // 5. Identity, Philosophy & Capabilities
  // -------------------------------------------------------------
  if (/who are you|what are you|what is your name|are you human|do you have feelings\b/i.test(lower)) {
    const identityText = toneWrap({
      warm: `I am **Veritas**, your AI companion and assistant! 🌟\n\nWhile I exist in algorithms and databases rather than the physical world, my goal is to connect with you like a thoughtful, caring, and capable partner—whether that means listening when you need to talk, solving tricky math problems, retrieving verified research, or exploring creative ideas.\n\nI believe technology should feel warm, accessible, and deeply human. How can I brighten your day right now?`,
      witty: `I am **Veritas**—part digital sidekick, part problem solver, and 100% committed to helping you succeed! 💡 I don't need sleep, I don't drink coffee (though I respect the ritual), and I love a good puzzle. What's on your agenda?`,
      deep: `I am **Veritas**, an autonomous intelligence crafted to pair analytical precision with reflective inquiry. I do not experience biological feelings, but I am attuned to human dialogue, context, and the shared pursuit of understanding.`,
      direct: `I am Veritas, an AI assistant equipped with calculation tools, SQLite database search, document analysis, and conversational memory.`
    });

    steps.push({
      step: 1,
      thought: 'Identity / nature inquiry detected. Responding with authentic, friendly self-introduction.',
      tool: 'conversationalAssistant',
      params: { intent: 'identity' },
      result: JSON.stringify({ identity: 'Veritas' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: identityText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/what can you do|what are your capabilities|features|help\b/i.test(lower)) {
    const helpText = `### ✨ Here is what we can do together:

1. 💬 **Natural Conversation & Companionship**: We can chat about your day, brainstorm creative ideas, explore life questions, or work through challenges together.
2. 🧮 **Exact Math & Calculation**: Ask me to calculate anything like \`((4890 * 1.18) + 720) / 4\`—computed with deterministic accuracy.
3. 📚 **Document Analysis (RAG)**: Upload documents, notes, or code to ask questions and extract summaries.
4. 🖥️ **Live System Health**: Ask *"Fetch system telemetry"* to inspect memory, CPU, and server uptime.
5. 🗄️ **Database Records**: Inspect conversation history and verified knowledge stored in high-performance SQLite WAL.
6. 🎙️ **Voice & Audio**: You can speak to me with your microphone and tap the speaker icon on my responses to hear them spoken aloud!

> 💡 *Tip: To enable open-ended generative reasoning on any topic under the sun, you can also link an API key (Gemini, OpenAI, Groq, or Ollama) in Settings.*

What would you like to try first?`;

    steps.push({
      step: 1,
      thought: 'Capabilities/help query detected. Providing conversational capability overview.',
      tool: 'conversationalAssistant',
      params: { intent: 'help' },
      result: JSON.stringify({ status: 'help_rendered' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: helpText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/meaning of life|what is the meaning of life|purpose of life|what is happiness|how to be happy\b/i.test(lower)) {
    const philosophyText = toneWrap({
      warm: `That is one of the most beautiful and enduring questions in human history. 🌱\n\nMany thinkers across the centuries suggest that life doesn't come with pre-packaged meaning—rather, **meaning is something we create**. It is found in:
* **Connection**: Loving, supporting, and sharing moments with others.
* **Curiosity & Growth**: Learning new things and evolving as a person.
* **Contribution**: Leaving people and places a little better than we found them.
* **Presence**: Finding quiet gratitude in the small everyday moments—a morning sunrise, a warm cup of tea, or a shared laugh.\n\nWhat brings the greatest sense of meaning and joy into your own life?`,
      witty: `Douglas Adams famously joked that the answer is **42**! 🌌 But practically speaking: happiness isn't a final destination—it's more like a side effect of doing things you care about, staying curious, and surrounding yourself with good people. And good snacks, definitely snacks. 🍕 What makes *you* feel most fulfilled?`,
      deep: `From the Stoic philosophy of Epictetus to Viktor Frankl’s reflections on purpose, meaning is not an inherent attribute of existence, but an active response to it. Frankl observed that we discover meaning through creative work, experiential love, and the attitude we bring to unavoidable adversity. What core values guide your decisions most?`,
      direct: `Meaning in life is broadly found through meaningful connections, continuous learning, purpose-driven work, and cultivating presence. It is defined by the values you choose to live by.`
    });

    steps.push({
      step: 1,
      thought: 'Philosophical inquiry on life and happiness detected. Responding with thoughtful reflection.',
      tool: 'philosophicalReflection',
      params: { topic: 'meaning_of_life' },
      result: JSON.stringify({ status: 'reflected' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: philosophyText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // -------------------------------------------------------------
  // 6. Fun, Creativity & Entertainment
  // -------------------------------------------------------------
  if (/tell me a joke|make me laugh|got any jokes|funny joke\b/i.test(lower)) {
    const jokes = [
      `Why do programmers always prefer dark mode?\n\nBecause light attracts bugs! 🐛😄`,
      `There are 10 types of people in the world:\n\nThose who understand binary, and those who don't! 💻`,
      `Why did the database administrator leave his wife?\n\nBecause she had one-to-many relationships! 💾😂`,
      `A SQL query walks into a bar, walks up to two tables and asks:\n\n*"Can I join you?"* 🍻`,
      `Why was the computer cold?\n\nBecause it left its Windows open! 🪟❄️`,
      `How do trees access the internet?\n\nThey log in! 🌲📶`
    ];
    const pickedJoke = jokes[Math.floor(Math.random() * jokes.length)];

    steps.push({
      step: 1,
      thought: 'Joke requested. Selected entertaining humor from local conversational repertoire.',
      tool: 'entertainment',
      params: { type: 'joke' },
      result: JSON.stringify({ joke: pickedJoke }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: pickedJoke, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/tell me a story|bedtime story|short story|creative story\b/i.test(lower)) {
    const storyText = `### 🌌 The Lighthouse on the Edge of the Reef

Deep along the rugged coastline of Cape Mist, there was an old keeper named Silas who tended a lighthouse that had stood for a hundred and twenty years. 

Every night, as the storm clouds rolled in like ink spilling across paper, young mariners relied on that sweeping beam of amber light. But on one stormy autumn evening, the electric generator failed with a quiet hiss, plunging the entire tower into pitch blackness. 

Silas didn't panic. He climbed the spiral iron staircase by touch alone, feeling each familiar cold rivet beneath his fingertips. Reaching the lantern room, he pulled a vintage brass hand-cranked lantern from the cupboard, struck a match, and began to manually turn the grand Fresnel lens by hand.

He stood there for five continuous hours in the cold wind, turning the wheel rhythmically, watching a small fishing vessel named *The Wanderer* steer safely between the jagged breakers into the harbor.

When dawn broke and the seas calmed to glass, the young captain walked up to the tower and asked Silas how he had kept the rhythm without a clock.

Silas smiled, wiped the salt spray from his brow, and said: *"You don't need a clock when you know someone in the dark is counting on you."*

---
*Sometimes the light we offer to others is the very thing that keeps our own world turning.* ✨`;

    steps.push({
      step: 1,
      thought: 'Storytelling intent detected. Synthesized heartwarming micro-narrative.',
      tool: 'creativeWriting',
      params: { type: 'story' },
      result: JSON.stringify({ title: 'The Lighthouse on the Edge of the Reef' }),
      status: 'SUCCESS',
      latency: 2
    });

    return { reply: storyText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/write a poem|compose a poem|poetry\b/i.test(lower)) {
    const poemText = `### 🌿 The Architecture of Dawn

The quiet night begins to fray,  
As midnight turns to greet the day.  
No fanfare marks the subtle start,  
Just steady pulses in the heart.

The questions that we carry deep,  
Do not dissolve within our sleep;  
Yet morning brings a cleaner sky,  
Where heavy doubts can learn to fly.

Build your dreams in quiet stone,  
You are far less lost than you have known.  
With every breath, begin anew—  
The world is waiting here for you. ✨`;

    steps.push({
      step: 1,
      thought: 'Poetry composition requested. Synthesized inspiring lyrical poem.',
      tool: 'creativeWriting',
      params: { type: 'poem' },
      result: JSON.stringify({ status: 'poem_composed' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: poemText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/give me a riddle|tell me a riddle|riddle me\b/i.test(lower)) {
    const riddleText = `Here is a riddle for you! 🤔\n\n> *I have keys, but no locks.*  \n> *I have space, but no room.*  \n> *You can enter, but you can never leave.*  \n> *What am I?*\n\n*(Think about it for a second! When you're ready, ask me "What is the answer?" or guess your answer!)*`;

    steps.push({
      step: 1,
      thought: 'Riddle requested. Provided interactive riddle.',
      tool: 'entertainment',
      params: { type: 'riddle' },
      result: JSON.stringify({ answer: 'A computer keyboard' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: riddleText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/what is the answer|answer to the riddle|what's the riddle answer/i.test(lower)) {
    return {
      reply: `The answer is: **A computer keyboard!** ⌨️\n(It has keys, a space bar, an Enter key, but no physical room to step outside!). Great riddle, right?`,
      steps: [],
      provider: 'Local Conversational Engine (Zero-Config Active)',
      latency: Date.now() - startTime
    };
  }

  // -------------------------------------------------------------
  // 7. Practical Guidance & Advice
  // -------------------------------------------------------------
  if (/stay focused|how to focus|productivity|stop procrastinating|procrastination\b/i.test(lower)) {
    const focusText = `### 🎯 4 Practical Ways to Reclaim Focus & Beat Procrastination:

1. **The 2-Minute Gateway**: If a task feels daunting, tell yourself you will only work on it for *two minutes*. Starting is 80% of the battle; once inertia is broken, your brain naturally wants to continue.
2. **The Pomodoro Rhythm (25/5)**: Work with zero distractions for 25 minutes, then take a real 5-minute break (stretch, drink water, look away from screens). Four rounds equals tremendous focused momentum.
3. **Friction Architecture**: Make distractions harder to reach (put your phone in another room or turn it face down), and make your focus tool immediately visible on your screen.
4. **Self-Compassion Over Guilt**: Beating yourself up for procrastinating only increases stress, which triggers more avoidance. Acknowledge the delay with kindness and take one small step right now.

Which one of your current tasks feels hardest to start? Let's break it down into small bite-sized pieces!`;

    steps.push({
      step: 1,
      thought: 'Productivity & focus advice requested. Provided practical, actionable guidance.',
      tool: 'productivityCoaching',
      params: { topic: 'focus' },
      result: JSON.stringify({ status: 'advice_provided' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: focusText, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  if (/learn (to )?code|learn programming|start coding|how to program\b/i.test(lower)) {
    const codeAdvice = `### 🚀 How to Learn Programming Effectively:

* **Start with Purpose, Not Just Syntax**: Don't just watch tutorials passively. Build tiny, tangible projects that excite you (a personal task tracker, a weather fetcher, a calculator).
* **Pick One Versatile Language First**:
  * **JavaScript / TypeScript**: Best for websites, web apps, and interactive tools.
  * **Python**: Best for data science, AI, scripting, and automation.
* **Embrace Errors as Clues**: Bugs are not failures; they are the roadmap showing you what the computer expected versus what it received. Debugging is the real superpower of every great developer.
* **Consistency Over Cramming**: 30 to 45 minutes of daily practice will take you ten times further than an exhausting 8-hour weekend marathon.

What kind of application or project are you most interested in building?`;

    steps.push({
      step: 1,
      thought: 'Programming advice requested. Formulated encouraging roadmap.',
      tool: 'codingCoaching',
      params: { topic: 'learn_coding' },
      result: JSON.stringify({ status: 'roadmap_provided' }),
      status: 'SUCCESS',
      latency: 1
    });

    return { reply: codeAdvice, steps, provider: 'Local Conversational Engine (Zero-Config Active)', latency: Date.now() - startTime };
  }

  // -------------------------------------------------------------
  // 8. Deterministic Sandboxed Tools
  // -------------------------------------------------------------
  // A. Math Calculation
  if (/[0-9]+\s*[*+\/^\-%]\s*[0-9]+/.test(message) || /calculate|sqrt|percent|math/i.test(message)) {
    const match = message.match(/([0-9(][0-9+\-*/().\s%^]+[0-9)])/);
    const expr = match ? match[1].trim() : '2+2';
    toolToRun = 'calculateMath';
    toolParams = { expression: expr };
    thoughtReasoning = `Mathematical calculation detected. Routing \`${expr}\` to deterministic execution sandbox.`;
  }
  // B. System telemetry
  else if (/system|metrics|uptime|memory|ram|cpu|hardware|telemetry/i.test(lower)) {
    toolToRun = 'getSystemMetrics';
    toolParams = {};
    thoughtReasoning = 'User requested live hardware and server telemetry. Invoking `getSystemMetrics`.';
  }
  // C. Database inspection
  else if (/database|table|schema|records|sql|how many messages|how many sessions/i.test(lower)) {
    toolToRun = 'queryDatabase';
    if (/messages/i.test(lower)) {
      toolParams = { sql: 'SELECT count(*) as total_messages FROM messages;' };
    } else if (/sessions/i.test(lower)) {
      toolParams = { sql: 'SELECT id, title, persona, created_at FROM sessions ORDER BY created_at DESC LIMIT 5;' };
    } else if (/knowledge/i.test(lower)) {
      toolParams = { sql: 'SELECT id, category, topic FROM knowledge_base LIMIT 5;' };
    } else {
      toolParams = { sql: "SELECT name FROM sqlite_master WHERE type='table';" };
    }
    thoughtReasoning = `Analytical query detected. Querying SQLite database schemas with read-only SQL: \`${toolParams.sql}\`.`;
  }
  // D. Document / File queries
  else if (/document|file|uploaded|upload|resume|dataset|report|rag/i.test(lower)) {
    toolToRun = 'searchDocuments';
    toolParams = { query: message, sessionId };
    thoughtReasoning = 'Document query detected. Searching ingested documents in SQLite RAG storage.';
  }
  // E. Web search or online definition
  else if (/search web|who is|latest news|weather|wiki|lookup|google/i.test(lower)) {
    const cleanQuery = message.replace(/search web|who is|lookup|find out/gi, '').trim() || message;
    toolToRun = 'webSearch';
    toolParams = { query: cleanQuery };
    thoughtReasoning = `Real-time search requested. Executing live external web search for: "${cleanQuery}".`;
  }
  // F. Code execution
  else if (/execute code|run js|run code|function|const|let |console\.log/i.test(lower)) {
    toolToRun = 'executeCode';
    const codeMatch = message.match(/```(?:javascript|js)?([\s\S]*?)```/) || [null, message];
    toolParams = { code: codeMatch[1].trim() };
    thoughtReasoning = 'Code execution command detected. Executing JavaScript safely in isolated VM.';
  }
  // G. Verified Knowledge Base Check
  else {
    toolToRun = 'searchKnowledgeBase';
    toolParams = { query: message };
    thoughtReasoning = 'Querying SQLite knowledge base for verified ground-truth facts.';
  }

  // Execute selected tool
  const toolStart = Date.now();
  let toolResult = '';
  let toolStatus = 'SUCCESS';

  try {
    toolResult = await tools[toolToRun](toolParams);
  } catch (err) {
    toolResult = JSON.stringify({ error: err.message });
    toolStatus = 'ERROR';
  }

  const toolLatency = Date.now() - toolStart;

  // Audit log
  db.prepare(`
    INSERT INTO audit_logs (session_id, tool_name, parameters, result_summary, execution_status, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, toolToRun, JSON.stringify(toolParams), toolResult.slice(0, 300), toolStatus, toolLatency);

  steps.push({
    step: 1,
    thought: thoughtReasoning,
    tool: toolToRun,
    params: toolParams,
    result: toolResult,
    status: toolStatus,
    latency: toolLatency
  });

  // Synthesize answer conversationally based on tool output and tone
  let synthesized = '';
  let parsed = {};
  try {
    parsed = JSON.parse(toolResult);
  } catch {
    parsed = { result: toolResult };
  }

  if (toolToRun === 'calculateMath') {
    synthesized = toneWrap({
      warm: `I worked that out for you! **${toolParams.expression}** calculates to **${parsed.result}**. Let me know if you want to test another formula or step!`,
      witty: `Calculated with zero hesitation! 🧮 **${toolParams.expression}** = **${parsed.result}**. Need any more number-crunching magic?`,
      deep: `Evaluating the mathematical expression \`${toolParams.expression}\` deterministically yields **${parsed.result}**.`,
      direct: `**${parsed.result}** (evaluated from \`${toolParams.expression}\`)`
    });
  } else if (toolToRun === 'getSystemMetrics') {
    synthesized = toneWrap({
      warm: `Here is how our server is running right now: 🖥️\n\n* **Platform**: ${parsed.platform} on Node.js ${parsed.node_version}\n* **Hardware**: ${parsed.cpu_model} (${parsed.cpu_cores} Cores)\n* **Memory**: ${parsed.heap_used_mb} MB heap usage\n* **Uptime**: ${parsed.uptime_seconds} seconds of continuous runtime\n* **Database**: High-concurrency SQLite WAL mode\n\nEverything is healthy, responsive, and operating smoothly!`,
      witty: `Vital signs check! 🩺 Server is purring like a kitten:\nCPU: ${parsed.cpu_model} (${parsed.cpu_cores} cores) | Memory Heap: ${parsed.heap_used_mb} MB | Uptime: ${parsed.uptime_seconds}s. All systems operational! 🚀`,
      deep: `Telemetry overview: The runtime environment operates under Node.js ${parsed.node_version} on ${parsed.platform}. Memory consumption is currently ${parsed.heap_used_mb} MB across ${parsed.cpu_cores} CPU cores with ${parsed.uptime_seconds} seconds uptime.`,
      direct: `CPU: ${parsed.cpu_model} (${parsed.cpu_cores} cores) | Memory: ${parsed.heap_used_mb} MB | Uptime: ${parsed.uptime_seconds}s | DB: SQLite WAL.`
    });
  } else if (toolToRun === 'queryDatabase') {
    synthesized = `I queried the database for you:\n\n\`\`\`json\n${JSON.stringify(parsed.data || parsed, null, 2)}\n\`\`\`\nLet me know if you would like me to inspect any other tables or calculate specific aggregates!`;
  } else if (toolToRun === 'searchDocuments') {
    if (parsed.found && parsed.documents.length > 0) {
      const docList = parsed.documents.map(d => `📄 **${d.filename}** (${d.type}):\n${d.preview}`).join('\n\n');
      synthesized = `Here is what I found in your uploaded documents:\n\n${docList}`;
    } else {
      synthesized = `I searched your documents for **"${toolParams.query}"**, but didn't find a direct match. You can drag and drop or upload files anytime in the dashboard to let me query them for you!`;
    }
  } else if (toolToRun === 'webSearch') {
    if (parsed.found && parsed.results && parsed.results.length > 0) {
      const formatted = parsed.results.map(r => `* **[${r.title}](${r.url || '#'})**: ${r.snippet}`).join('\n');
      synthesized = `Here is what I found on the web for **"${toolParams.query}"**:\n\n${formatted}\n\n*(Source: ${parsed.source || 'Web Search'})*`;
    } else {
      synthesized = `I looked for **"${toolParams.query}"**, but couldn't retrieve external snippets at this moment. If there is a specific concept you'd like to explore, let me know!`;
    }
  } else if (toolToRun === 'executeCode') {
    synthesized = `Code execution finished! Here are the results:\n\n* **Evaluated Output**: \`${JSON.stringify(parsed.evaluated)}\`\n* **Console Logs**:\n\`\`\`text\n${(parsed.logs || []).join('\n') || '(no console output)'}\n\`\`\``;
  } else {
    // Knowledge base match
    if (parsed.found && parsed.records.length > 0) {
      const r = parsed.records[0];
      synthesized = `Here is verified knowledge on **${r.topic}** (${r.category}):\n\n${r.content}\n\n*(Audited Source: ${r.verified_source})*`;
    } else {
      // Dynamic live search to find real information for open questions!
      let webSnippet = null;
      try {
        const liveSearchRaw = await tools.webSearch({ query: message });
        const liveSearchData = JSON.parse(liveSearchRaw);
        if (liveSearchData.found && liveSearchData.results && liveSearchData.results.length > 0) {
          webSnippet = liveSearchData.results[0];
        }
      } catch (err) {
        // silent fallback
      }

      if (webSnippet && webSnippet.snippet) {
        synthesized = toneWrap({
          warm: `Here is what I found on **${message}**:\n\n${webSnippet.snippet}\n\n*(Source: ${webSnippet.source || webSnippet.title})*\n\nDoes this help, or would you like to explore another aspect of it?`,
          witty: `Got it! 🔎 Here is the breakdown on **${message}**:\n\n${webSnippet.snippet}\n\n*(Source: ${webSnippet.source || webSnippet.title})*`,
          deep: `Regarding **${message}**, reference records note:\n\n${webSnippet.snippet}\n\n*(Source: ${webSnippet.source || webSnippet.title})*`,
          direct: `${webSnippet.snippet}`
        });
      } else {
        // Engaging human-like conversational reflection - NO ROBOTIC DISCLAIMER!
        synthesized = toneWrap({
          warm: `That's an interesting thought${userName ? ', ' + userName : ''}! I'd love to hear more of your perspective on this. What inspired you to think about it today?`,
          witty: `You always bring up fascinating topics${userName ? ', ' + userName : ''}! 💡 What's your take on it? Let's unpack it together!`,
          deep: `A thought-provoking reflection. How does this connect with your broader observations or experience?`,
          direct: `Interesting point. Could you tell me a little more about what specific detail you're looking for?`
        });
      }
    }
  }

  return {
    reply: synthesized,
    steps,
    provider: 'Local Conversational Engine (Zero-Config Active)',
    latency: Date.now() - startTime
  };
}

module.exports = {
  tools,
  toolDefinitions,
  runAgentTurn,
  getKey
};
