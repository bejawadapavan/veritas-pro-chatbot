# Veritas Pro - Enterprise Autonomous AI Agentic Platform

> **Advanced Autonomous AI Copilot with Dynamic Multi-Provider API Key Attachment, Full SQLite WAL Database Backend, Multi-Session History, and 8 Sandboxed Deterministic ReAct Tools.**

---

## 🌟 Key Features

### 1. 🔑 Dynamic Multi-Provider API Key Manager
- Attach and configure API keys directly inside the application UI with real-time connection verification:
  - **Google Gemini**: Gemini 2.0 Flash, Gemini 1.5 Pro, Gemini 1.5 Flash
  - **OpenAI**: GPT-4o, GPT-4o-mini, o3-mini
  - **Groq**: Llama 3.3 70B (300+ tokens/sec), Mixtral 8x7B
  - **OpenRouter / DeepSeek**: DeepSeek-V3, DeepSeek-R1
  - **Anthropic Claude**: Claude 3.5 Sonnet, Claude 3.5 Haiku
  - **Local Ollama**: Local models (`llama3`, `mistral`, `deepseek-r1`)
- **Zero-Config Local Fallback Engine**: Works out-of-the-box even with zero external keys attached! The local engine handles calculations, database queries, system metrics, and knowledge searches.

### 2. 🤖 Autonomous Multi-Step ReAct Execution Engine
- Full Reasoning + Acting agent loop (Thought → Action → Observation → Synthesis).
- Collapsible interactive **Reasoning Trace cards** in the chat UI detailing:
  - Agent thoughts
  - Executed tool name
  - Parameters
  - Execution observation
  - Latency in milliseconds

### 3. 🛠️ 8 Sandboxed Deterministic Tools
1. **`calculateMath`**: High-precision arithmetic and algebraic computation without LLM prediction drift.
2. **`searchKnowledgeBase`**: Fast SQLite query over audited, verified ground-truth facts.
3. **`searchDocuments`**: Ingested document RAG retrieval across uploaded user documents and codebases.
4. **`webSearch`**: Real-time web queries and encyclopedic definitions via live APIs.
5. **`fetchWebPage`**: Web scraping and clean text extraction from any URL.
6. **`executeCode`**: Safe sandboxed JavaScript evaluation in isolated `node:vm` runtime.
7. **`queryDatabase`**: Read-only SQL query explorer for inspecting SQLite tables and analytical metrics.
8. **`getSystemMetrics`**: Real-time CPU, RAM, uptime, and database records telemetry.

### 4. 💾 Total SQLite Database Backend (WAL Mode)
- **High Concurrency**: Utilizes SQLite Write-Ahead Logging (`WAL`) mode for concurrent reads and writes.
- **Enterprise Tables**:
  - `sessions`: Multi-session chat conversations with persona and model preferences.
  - `messages`: Full message history with thoughts, tool traces, and tokens.
  - `knowledge_base`: Ground-truth facts to eliminate hallucination.
  - `documents`: Uploaded files (text, code, markdown, csv) for instant RAG analysis.
  - `audit_logs`: Detailed telemetry of every tool call and latency.
  - `settings`: In-app key configuration and provider settings.

### 5. 🎨 Modern Glassmorphism Dashboard
- 3-Column responsive layout with Tailwind CSS, Lucide icons, Marked.js, and Prism.js syntax highlighting with one-click "Copy Code".
- Ingest documents via drag-and-drop or file upload.
- One-click benchmark test prompts.
- Export conversations to Markdown or JSON.

---

## 🚀 Quick Start

### 1. Start the Server
```bash
node server.js
```
The application will start at `http://localhost:3000`.

### 2. Attach API Keys
1. Click **"Attach API Keys"** in the top navigation bar.
2. Enter your API key for Google Gemini, OpenAI, Groq, OpenRouter, or Ollama.
3. Click **"Test Connection"** to verify roundtrip connectivity.
4. Click **"Save Configuration"** to persist it to the SQLite database.

---

## 📡 REST API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | Database health, active LLM engine, telemetry |
| `/api/sessions` | GET / POST | List all conversations or create a new session |
| `/api/sessions/:id` | PATCH / DELETE | Rename or delete a conversation |
| `/api/sessions/:id/messages` | GET / DELETE | Retrieve or clear conversation history |
| `/api/chat` | POST | Send message and execute autonomous ReAct loop |
| `/api/settings` | GET / POST | Retrieve masked settings or save new API keys |
| `/api/settings/test-key` | POST | Live ping test for provider API key |
| `/api/tools` | GET | List all active tools and parameter schemas |
| `/api/knowledge` | GET / POST / DELETE | Manage verified knowledge base facts |
| `/api/upload` | POST | Ingest document / text into RAG memory |
| `/api/documents` | GET / DELETE | List or delete ingested documents |
| `/api/audit-logs` | GET | Retrieve live tool execution telemetry |
| `/api/database/query` | POST | Read-only SQL query explorer |
| `/api/export/:sessionId` | GET | Export session as Markdown or JSON |
