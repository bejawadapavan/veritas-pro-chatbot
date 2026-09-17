// Initialize Lucide Icons
lucide.createIcons();

// Configure Marked.js
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: function (code, lang) {
    if (Prism.languages[lang]) {
      return Prism.highlight(code, Prism.languages[lang], lang);
    }
    return code;
  }
});

// State Management
let currentSessionId = 'main-session';
let currentPersona = 'general';
let currentModel = 'auto';
let sessionsCache = [];
let attachedFile = null;

// DOM Elements
const messagesThread = document.getElementById('messagesThread');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const sessionList = document.getElementById('sessionList');
const currentSessionTitle = document.getElementById('currentSessionTitle');
const agentStatusBadge = document.getElementById('agentStatusBadge');
const agentStatusText = document.getElementById('agentStatusText');
const activeProviderLabel = document.getElementById('activeProviderLabel');
const modelSelector = document.getElementById('modelSelector');

// Modals & Panels
const settingsModal = document.getElementById('settingsModal');
const btnOpenSettings = document.getElementById('btnOpenSettings');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnCancelSettings = document.getElementById('btnCancelSettings');
const settingsForm = document.getElementById('settingsForm');

const factModal = document.getElementById('factModal');
const btnOpenAddFact = document.getElementById('btnOpenAddFact');
const btnCloseFactModal = document.getElementById('btnCloseFactModal');
const factForm = document.getElementById('factForm');

const btnNewSession = document.getElementById('btnNewSession');
const btnRenameSession = document.getElementById('btnRenameSession');
const btnClearHistory = document.getElementById('btnClearHistory');
const btnExportChat = document.getElementById('btnExportChat');
const searchSessionsInput = document.getElementById('searchSessionsInput');

// Drawer & Tabs
const btnToggleDrawer = document.getElementById('btnToggleDrawer');
const sidebarRight = document.getElementById('sidebarRight');
const drawerTabs = document.querySelectorAll('.drawer-tab');
const tabContentKnowledge = document.getElementById('tabContentKnowledge');
const tabContentAudit = document.getElementById('tabContentAudit');
const tabContentDb = document.getElementById('tabContentDb');

// Attachment Elements
const fileInput = document.getElementById('fileInput');
const attachmentPreview = document.getElementById('attachmentPreview');
const attachmentFileName = document.getElementById('attachmentFileName');
const attachmentFileSize = document.getElementById('attachmentFileSize');
const btnRemoveAttachment = document.getElementById('btnRemoveAttachment');
const ragFileInput = document.getElementById('ragFileInput');

// -------------------------------------------------------------
// Initialization & Core Fetchers
// -------------------------------------------------------------
async function init() {
  await fetchStatus();
  await loadSettings();
  await loadSessions();
  await loadKnowledge();
  await loadDocuments();
  await loadAuditLogs();
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    
    document.getElementById('dbBadge').innerText = data.database ? 'WAL Active' : 'Offline';
    document.getElementById('statSessionsCount').innerText = data.stats.sessions;
    document.getElementById('statMsgsCount').innerText = data.stats.messages;
    activeProviderLabel.innerText = data.activeEngine;

    // Check key presence dot
    const keyDot = document.getElementById('keyStatusDot');
    if (data.activeEngine.includes('Connected')) {
      keyDot.className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400';
    } else {
      keyDot.className = 'w-2 h-2 rounded-full bg-amber-400 shadow-sm shadow-amber-400';
    }
  } catch (err) {
    console.error('Status fetch error:', err);
  }
}

// -------------------------------------------------------------
// Session Management
// -------------------------------------------------------------
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    sessionsCache = await res.json();
    renderSessionList(sessionsCache);

    // If currentSessionId not in list, pick the first
    if (!sessionsCache.find(s => s.id === currentSessionId) && sessionsCache.length > 0) {
      currentSessionId = sessionsCache[0].id;
    }
    
    const active = sessionsCache.find(s => s.id === currentSessionId);
    if (active) {
      currentSessionTitle.innerText = active.title;
      currentPersona = active.persona || 'general';
      updatePersonaButtons(currentPersona);
    }

    await loadHistory(currentSessionId);
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

function renderSessionList(list) {
  sessionList.innerHTML = list.map(s => {
    const isActive = s.id === currentSessionId;
    return `
      <div onclick="switchSession('${s.id}')" class="group p-2.5 rounded-xl cursor-pointer transition flex items-center justify-between border ${
        isActive 
          ? 'bg-brand-600/20 border-brand-500/40 text-white shadow-sm' 
          : 'bg-slate-950/40 border-slate-800/60 text-slate-300 hover:border-slate-700 hover:bg-slate-800/40'
      }">
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <i data-lucide="message-square" class="w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-brand-400' : 'text-slate-500'}"></i>
          <span class="text-xs truncate font-medium">${escapeHtml(s.title)}</span>
        </div>
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition flex-shrink-0 ml-1">
          <button onclick="event.stopPropagation(); deleteSession('${s.id}')" class="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400" title="Delete conversation">
            <i data-lucide="trash" class="w-3 h-3"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
  lucide.createIcons();
}

async function switchSession(id) {
  if (currentSessionId === id) return;
  currentSessionId = id;
  const s = sessionsCache.find(item => item.id === id);
  if (s) {
    currentSessionTitle.innerText = s.title;
    currentPersona = s.persona || 'general';
    updatePersonaButtons(currentPersona);
  }
  renderSessionList(sessionsCache);
  await loadHistory(id);
}

btnNewSession.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'New Autonomous Conversation',
        persona: currentPersona,
        provider: 'auto',
        model: modelSelector.value
      })
    });
    const newSess = await res.json();
    currentSessionId = newSess.id;
    await loadSessions();
    chatInput.focus();
  } catch (err) {
    alert('Failed to create session: ' + err.message);
  }
});

btnRenameSession.addEventListener('click', async () => {
  const current = sessionsCache.find(s => s.id === currentSessionId);
  const newTitle = prompt('Enter new conversation title:', current ? current.title : '');
  if (!newTitle || !newTitle.trim()) return;

  try {
    await fetch(`/api/sessions/${currentSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() })
    });
    await loadSessions();
  } catch (err) {
    alert('Failed to rename session: ' + err.message);
  }
});

async function deleteSession(id) {
  if (!confirm('Are you sure you want to delete this conversation? All messages will be permanently removed.')) return;
  try {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (currentSessionId === id) {
      currentSessionId = 'main-session';
    }
    await loadSessions();
  } catch (err) {
    alert('Failed to delete session: ' + err.message);
  }
}

btnClearHistory.addEventListener('click', async () => {
  if (!confirm('Clear all messages in the current conversation?')) return;
  try {
    await fetch(`/api/sessions/${currentSessionId}/messages`, { method: 'DELETE' });
    messagesThread.innerHTML = '';
    await fetchStatus();
  } catch (err) {
    alert('Failed to clear messages: ' + err.message);
  }
});

searchSessionsInput.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  if (!q) {
    renderSessionList(sessionsCache);
    return;
  }
  const filtered = sessionsCache.filter(s => s.title.toLowerCase().includes(q));
  renderSessionList(filtered);
});

// -------------------------------------------------------------
// Message History & Rendering
// -------------------------------------------------------------
async function loadHistory(sessionId) {
  messagesThread.innerHTML = '';
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`);
    const history = await res.json();
    
    if (history.length === 0) {
      // Show default starter hero
      messagesThread.innerHTML = `
        <div class="max-w-3xl mx-auto p-6 rounded-2xl bg-gradient-to-b from-slate-900/90 to-slate-950 border border-slate-800/80 text-slate-300 space-y-4 shadow-xl">
          <div class="flex items-center gap-3">
            <div class="p-2 rounded-xl bg-brand-600/20 border border-brand-500/30 text-brand-400">
              <i data-lucide="sparkles" class="w-6 h-6"></i>
            </div>
            <div>
              <h2 class="text-base font-bold text-white tracking-tight">Veritas Pro Autonomous Agentic Environment</h2>
              <p class="text-xs text-slate-400">Connected to SQLite database with WAL mode and 8 autonomous tool execution sandboxes.</p>
            </div>
          </div>
          <div class="pt-2 border-t border-slate-800/60">
            <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-2">Test Benchmarks:</span>
            <div class="flex flex-wrap gap-2">
              <button onclick="fillPrompt('What is ((4890 * 1.18) + 720) / 4?')" class="benchmark-pill text-xs px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-brand-500/50 hover:bg-slate-800/60 text-slate-300 transition flex items-center gap-1.5">
                <i data-lucide="calculator" class="w-3 h-3 text-amber-400"></i>
                <span>Exact Math Formula</span>
              </button>
              <button onclick="fillPrompt('What is Agentic AI according to the verified database?')" class="benchmark-pill text-xs px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-brand-500/50 hover:bg-slate-800/60 text-slate-300 transition flex items-center gap-1.5">
                <i data-lucide="shield-check" class="w-3 h-3 text-emerald-400"></i>
                <span>Query Ground Truth DB</span>
              </button>
              <button onclick="fillPrompt('Show all tables and row counts in our SQLite database')" class="benchmark-pill text-xs px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-brand-500/50 hover:bg-slate-800/60 text-slate-300 transition flex items-center gap-1.5">
                <i data-lucide="database" class="w-3 h-3 text-sky-400"></i>
                <span>Inspect Database Schema</span>
              </button>
              <button onclick="fillPrompt('Fetch live system metrics and runtime memory')" class="benchmark-pill text-xs px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-brand-500/50 hover:bg-slate-800/60 text-slate-300 transition flex items-center gap-1.5">
                <i data-lucide="cpu" class="w-3 h-3 text-purple-400"></i>
                <span>Server & Hardware Telemetry</span>
              </button>
            </div>
          </div>
        </div>
      `;
      lucide.createIcons();
      return;
    }

    history.forEach(item => {
      appendMessage(item.role, item.content, item.tool_meta, {
        thoughts: item.thoughts,
        timestamp: item.created_at
      });
    });
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function appendMessage(role, content, steps = null, options = {}) {
  const isUser = role === 'user';
  const wrapper = document.createElement('div');
  wrapper.className = `flex ${isUser ? 'justify-end' : 'justify-start'} w-full`;

  const card = document.createElement('div');
  card.className = `max-w-[90%] sm:max-w-[85%] rounded-2xl p-4 text-xs leading-relaxed space-y-3 shadow-xl ${
    isUser 
      ? 'bg-gradient-to-r from-brand-600 to-indigo-600 text-white rounded-br-none shadow-brand-600/20' 
      : 'bg-slate-900/90 border border-slate-800/90 text-slate-200 rounded-bl-none'
  }`;

  // Reasoning / Tools Accordion
  let reasoningHtml = '';
  if (steps && Array.isArray(steps) && steps.length > 0) {
    const stepsRendered = steps.map((s, idx) => `
      <div class="p-2.5 rounded-lg bg-slate-950/90 border border-slate-800/80 space-y-1.5 font-mono text-[11px]">
        <div class="flex items-center justify-between text-brand-300">
          <span class="flex items-center gap-1.5 font-bold">
            <i data-lucide="terminal" class="w-3 h-3 text-brand-400"></i>
            Step ${idx + 1}: \`${s.tool}\`
          </span>
          <span class="text-[10px] px-1.5 py-0.5 rounded ${s.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400'}">
            ${s.latency ? s.latency + 'ms' : 'Executed'}
          </span>
        </div>
        ${s.thought ? `<div class="text-slate-400 italic text-[10px]">${escapeHtml(s.thought)}</div>` : ''}
        <div class="text-slate-500 text-[10px] overflow-x-auto">
          <span class="text-slate-400 font-semibold">Params:</span> ${escapeHtml(JSON.stringify(s.params))}
        </div>
        <div class="text-slate-400 text-[10px] bg-slate-900/60 p-1.5 rounded border border-slate-800/50 max-h-24 overflow-y-auto">
          <span class="text-slate-400 font-semibold">Observation:</span> ${escapeHtml(typeof s.result === 'object' ? JSON.stringify(s.result) : s.result)}
        </div>
      </div>
    `).join('');

    reasoningHtml = `
      <details class="reasoning-card mb-2 rounded-xl bg-slate-950/60 border border-brand-500/20 overflow-hidden">
        <summary class="px-3 py-2 bg-brand-500/10 hover:bg-brand-500/15 cursor-pointer flex items-center justify-between text-[11px] font-semibold text-brand-300 select-none">
          <span class="flex items-center gap-2">
            <i data-lucide="workflow" class="w-3.5 h-3.5 text-brand-400"></i>
            Autonomous Reasoning Trace (${steps.length} tool call${steps.length > 1 ? 's' : ''})
          </span>
          <span class="text-[10px] bg-brand-500/20 px-2 py-0.5 rounded-full text-brand-200">Inspect Steps ▾</span>
        </summary>
        <div class="p-3 space-y-2 border-t border-slate-800">
          ${stepsRendered}
        </div>
      </details>
    `;
  }

  // Parse markdown
  let parsedContent = marked.parse(content || '');

  card.innerHTML = `
    <div class="flex items-center justify-between pb-1 border-b ${isUser ? 'border-brand-400/30' : 'border-slate-800/80'}">
      <div class="font-bold ${isUser ? 'text-brand-100' : 'text-brand-400'} flex items-center gap-1.5">
        <i data-lucide="${isUser ? 'user' : 'sparkles'}" class="w-3.5 h-3.5"></i>
        <span>${isUser ? 'Operator' : 'Veritas Pro Agent'}</span>
      </div>
      <div class="flex items-center gap-2 text-[10px] ${isUser ? 'text-brand-200' : 'text-slate-500'}">
        <span>${options.timestamp ? formatTime(options.timestamp) : 'Just now'}</span>
        <button onclick="copyToClipboard(this)" data-content="${escapeHtml(content)}" class="p-1 hover:text-white transition" title="Copy text">
          <i data-lucide="copy" class="w-3 h-3"></i>
        </button>
      </div>
    </div>
    ${reasoningHtml}
    <div class="markdown-body">${parsedContent}</div>
  `;

  // Attach copy buttons to pre blocks
  card.querySelectorAll('pre').forEach(pre => {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-code-btn';
    copyBtn.innerText = 'Copy';
    copyBtn.onclick = () => {
      const code = pre.querySelector('code')?.innerText || pre.innerText;
      navigator.clipboard.writeText(code);
      copyBtn.innerText = 'Copied!';
      setTimeout(() => copyBtn.innerText = 'Copy', 2000);
    };
    pre.appendChild(copyBtn);
  });

  wrapper.appendChild(card);
  messagesThread.appendChild(wrapper);
  messagesThread.scrollTop = messagesThread.scrollHeight;
  lucide.createIcons();
}

// -------------------------------------------------------------
// Chat Submission
// -------------------------------------------------------------
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const rawMessage = chatInput.value.trim();
  if (!rawMessage && !attachedFile) return;

  let messageToSend = rawMessage;
  if (attachedFile) {
    messageToSend = `[Attached Document: ${attachedFile.name}]\n\`\`\`${attachedFile.name.split('.').pop()}\n${attachedFile.content}\n\`\`\`\n\n${rawMessage || 'Please analyze this document.'}`;
  }

  appendMessage('user', messageToSend);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  
  // Clear attached file
  clearAttachment();

  chatInput.disabled = true;
  sendBtn.disabled = true;

  // Show Agent Status Pill
  agentStatusBadge.classList.remove('hidden');
  agentStatusBadge.classList.add('flex');
  agentStatusText.innerText = 'Formulating autonomous execution plan...';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: currentSessionId,
        message: messageToSend,
        persona: currentPersona,
        provider: 'auto',
        model: modelSelector.value
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Server error during agent turn.');
    }

    appendMessage('assistant', data.response, data.steps, {
      timestamp: new Date().toISOString()
    });

    // Refresh audit logs & DB stats
    await fetchStatus();
    loadAuditLogs();
    
    // Auto-update conversation title if it was first message
    const current = sessionsCache.find(s => s.id === currentSessionId);
    if (current && (current.title === 'New Autonomous Conversation' || current.title === 'Main Production Workspace')) {
      const autoTitle = rawMessage.slice(0, 32) + (rawMessage.length > 32 ? '...' : '');
      fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: autoTitle })
      }).then(() => loadSessions());
    }

  } catch (err) {
    appendMessage('assistant', `⚠️ **Execution Error:** ${err.message}\n\n*Check your API key in Settings if calling external models.*`);
  } finally {
    agentStatusBadge.classList.add('hidden');
    agentStatusBadge.classList.remove('flex');
    chatInput.disabled = false;
    sendBtn.disabled = false;
    chatInput.focus();
  }
});

// Auto-expand textarea on typing & handle Enter to submit
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (typeof chatForm.requestSubmit === 'function') {
      chatForm.requestSubmit();
    } else {
      sendBtn.click();
    }
  }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
});

// Fill prompt helper for benchmark buttons
window.fillPrompt = function (promptText) {
  chatInput.value = promptText;
  chatInput.focus();
  chatInput.dispatchEvent(new Event('input'));
};

// -------------------------------------------------------------
// Persona Switching
// -------------------------------------------------------------
document.querySelectorAll('.persona-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const persona = btn.getAttribute('data-persona');
    currentPersona = persona;
    updatePersonaButtons(persona);

    // Persist persona to active session
    if (currentSessionId) {
      await fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona })
      });
    }
  });
});

function updatePersonaButtons(activePersona) {
  document.querySelectorAll('.persona-btn').forEach(b => {
    if (b.getAttribute('data-persona') === activePersona) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });
}

// -------------------------------------------------------------
// File Attachments & Ingestion (RAG)
// -------------------------------------------------------------
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    attachedFile = {
      name: file.name,
      content: evt.target.result,
      type: file.type || 'text/plain',
      size: file.size
    };
    attachmentFileName.innerText = file.name;
    attachmentFileSize.innerText = `(${(file.size / 1024).toFixed(1)} KB)`;
    attachmentPreview.classList.remove('hidden');
  };
  reader.readAsText(file);
});

btnRemoveAttachment.addEventListener('click', clearAttachment);

function clearAttachment() {
  attachedFile = null;
  fileInput.value = '';
  attachmentPreview.classList.add('hidden');
}

// RAG Document Ingestion from Right Sidebar
ragFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('sessionId', currentSessionId);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      alert(`Document "${file.name}" indexed into SQLite RAG memory!`);
      loadDocuments();
      fetchStatus();
    } else {
      alert('Upload failed: ' + data.error);
    }
  } catch (err) {
    alert('Upload error: ' + err.message);
  } finally {
    ragFileInput.value = '';
  }
});

async function loadDocuments() {
  try {
    const res = await fetch('/api/documents');
    const docs = await res.json();
    const container = document.getElementById('documentsList');

    if (docs.length === 0) {
      container.innerHTML = '<span class="text-[11px] text-slate-500 italic">No documents ingested yet. Upload one above.</span>';
      return;
    }

    container.innerHTML = docs.map(d => `
      <div class="p-2 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between text-[11px]">
        <div class="min-w-0 flex-1">
          <div class="font-medium text-slate-200 truncate">${escapeHtml(d.filename)}</div>
          <div class="text-[10px] text-slate-500">${(d.file_size / 1024).toFixed(1)} KB • ${formatTime(d.created_at)}</div>
        </div>
        <button onclick="deleteDocument(${d.id})" class="p-1 text-slate-500 hover:text-rose-400" title="Delete document">
          <i data-lucide="trash-2" class="w-3 h-3"></i>
        </button>
      </div>
    `).join('');
    lucide.createIcons();
  } catch (err) {
    console.error('Error loading documents:', err);
  }
}

window.deleteDocument = async function (id) {
  if (!confirm('Remove this document from RAG index?')) return;
  try {
    await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    loadDocuments();
    fetchStatus();
  } catch (err) {
    alert('Failed to delete document: ' + err.message);
  }
};

// -------------------------------------------------------------
// Knowledge Base Management
// -------------------------------------------------------------
async function loadKnowledge() {
  try {
    const res = await fetch('/api/knowledge');
    const records = await res.json();
    const container = document.getElementById('knowledgeList');

    if (records.length === 0) {
      container.innerHTML = '<span class="text-[11px] text-slate-500 italic">No verified facts in database.</span>';
      return;
    }

    container.innerHTML = records.map(r => `
      <div class="p-2.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 transition space-y-1">
        <div class="flex justify-between items-center">
          <span class="font-bold text-xs text-brand-300">${escapeHtml(r.topic)}</span>
          <span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">${escapeHtml(r.category)}</span>
        </div>
        <p class="text-[11px] text-slate-300 leading-snug">${escapeHtml(r.content)}</p>
        <div class="flex justify-between items-center text-[9px] text-slate-500 pt-1">
          <span class="truncate italic">Src: ${escapeHtml(r.verified_source)}</span>
          <button onclick="deleteFact(${r.id})" class="text-slate-500 hover:text-rose-400 ml-2" title="Delete record">
            <i data-lucide="trash" class="w-2.5 h-2.5"></i>
          </button>
        </div>
      </div>
    `).join('');
    lucide.createIcons();
  } catch (err) {
    console.error('Failed to load knowledge:', err);
  }
}

window.deleteFact = async function (id) {
  if (!confirm('Delete this verified fact from SQLite?')) return;
  try {
    await fetch(`/api/knowledge/${id}`, { method: 'DELETE' });
    loadKnowledge();
    fetchStatus();
  } catch (err) {
    alert('Failed to delete fact: ' + err.message);
  }
};

btnOpenAddFact.addEventListener('click', () => factModal.classList.remove('hidden'));
btnCloseFactModal.addEventListener('click', () => factModal.classList.add('hidden'));

factForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    topic: document.getElementById('factTopic').value.trim(),
    category: document.getElementById('factCategory').value.trim(),
    content: document.getElementById('factContent').value.trim(),
    source: document.getElementById('factSource').value.trim()
  };

  try {
    const res = await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      factModal.classList.add('hidden');
      factForm.reset();
      loadKnowledge();
      fetchStatus();
    }
  } catch (err) {
    alert('Failed to add fact: ' + err.message);
  }
});

// -------------------------------------------------------------
// Live Tool Audit Logs
// -------------------------------------------------------------
async function loadAuditLogs() {
  try {
    const res = await fetch('/api/audit-logs');
    const logs = await res.json();
    const container = document.getElementById('auditLogsList');

    if (logs.length === 0) {
      container.innerHTML = '<span class="text-[11px] text-slate-500 italic">No tool executions logged yet.</span>';
      return;
    }

    container.innerHTML = logs.map(l => `
      <div class="p-2 rounded-lg bg-slate-900 border border-slate-800 space-y-1 text-[11px] font-mono">
        <div class="flex justify-between items-center">
          <span class="font-bold text-brand-300 flex items-center gap-1">
            <i data-lucide="terminal" class="w-2.5 h-2.5 text-brand-400"></i>
            ${escapeHtml(l.tool_name)}
          </span>
          <span class="text-[9px] px-1.5 py-0.2 rounded ${l.execution_status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400'}">
            ${l.latency_ms}ms
          </span>
        </div>
        <div class="text-[10px] text-slate-400 truncate">Params: ${escapeHtml(l.parameters)}</div>
        <div class="text-[10px] text-slate-500">${formatTime(l.created_at)}</div>
      </div>
    `).join('');
    lucide.createIcons();
  } catch (err) {
    console.error('Failed to load audit logs:', err);
  }
}
document.getElementById('btnRefreshAudit').addEventListener('click', loadAuditLogs);

// -------------------------------------------------------------
// Database Explorer Tab
// -------------------------------------------------------------
const dbQueryForm = document.getElementById('dbQueryForm');
const dbQueryInput = document.getElementById('dbQueryInput');
const dbQueryOutput = document.getElementById('dbQueryOutput');

dbQueryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const sql = dbQueryInput.value.trim();
  if (!sql) return;

  dbQueryOutput.innerHTML = '<span class="text-brand-300 animate-pulse">Running read-only query...</span>';

  try {
    const res = await fetch('/api/database/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql })
    });
    const data = await res.json();

    if (!res.ok) {
      dbQueryOutput.innerHTML = `<span class="text-rose-400">Error: ${escapeHtml(data.error)}</span>`;
      return;
    }

    if (data.rows && data.rows.length > 0) {
      const keys = Object.keys(data.rows[0]);
      let tableHtml = `<table class="w-full text-left border-collapse"><thead><tr>`;
      keys.forEach(k => tableHtml += `<th class="border-b border-slate-700 p-1 text-slate-300">${k}</th>`);
      tableHtml += `</tr></thead><tbody>`;
      data.rows.forEach(row => {
        tableHtml += `<tr class="border-b border-slate-800/60">`;
        keys.forEach(k => {
          let val = row[k];
          if (typeof val === 'object') val = JSON.stringify(val);
          tableHtml += `<td class="p-1 text-slate-400 truncate max-w-[120px]">${escapeHtml(String(val))}</td>`;
        });
        tableHtml += `</tr>`;
      });
      tableHtml += `</tbody></table>`;
      dbQueryOutput.innerHTML = `<div class="mb-1 text-emerald-400 font-bold">${data.rowCount} row(s) returned:</div>` + tableHtml;
    } else {
      dbQueryOutput.innerHTML = '<span class="text-slate-400">Query executed successfully. 0 rows returned.</span>';
    }
  } catch (err) {
    dbQueryOutput.innerHTML = `<span class="text-rose-400">Execution failed: ${err.message}</span>`;
  }
});

// -------------------------------------------------------------
// Drawer Tabs Switching
// -------------------------------------------------------------
drawerTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    drawerTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    const target = tab.getAttribute('data-tab');
    tabContentKnowledge.classList.add('hidden');
    tabContentAudit.classList.add('hidden');
    tabContentDb.classList.add('hidden');

    if (target === 'knowledge') tabContentKnowledge.classList.remove('hidden');
    if (target === 'audit') {
      tabContentAudit.classList.remove('hidden');
      loadAuditLogs();
    }
    if (target === 'db') tabContentDb.classList.remove('hidden');
  });
});

btnToggleDrawer.addEventListener('click', () => {
  sidebarRight.classList.toggle('hidden');
});

// Mobile Sidebar Toggle
document.getElementById('btnToggleSidebarMobile').addEventListener('click', () => {
  document.getElementById('sidebarLeft').classList.toggle('hidden');
});

// -------------------------------------------------------------
// Settings & Dynamic API Key Attachment Modal
// -------------------------------------------------------------
btnOpenSettings.addEventListener('click', () => {
  loadSettings();
  settingsModal.classList.remove('hidden');
});
btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
btnCancelSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));

async function loadSettings() {
  try {
    const [resSettings, resStatus] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/status')
    ]);
    const data = await resSettings.json();
    const statusData = await resStatus.json();
    const s = data.settings || {};

    if (statusData.appMasterKey) {
      document.getElementById('inputAppMasterKey').value = statusData.appMasterKey;
    }

    if (s.GEMINI_API_KEY && s.GEMINI_API_KEY.configured) {
      document.getElementById('inputGeminiKey').placeholder = `Saved: ${s.GEMINI_API_KEY.preview}`;
    }
    if (s.OPENAI_API_KEY && s.OPENAI_API_KEY.configured) {
      document.getElementById('inputOpenAIKey').placeholder = `Saved: ${s.OPENAI_API_KEY.preview}`;
    }
    if (s.GROQ_API_KEY && s.GROQ_API_KEY.configured) {
      document.getElementById('inputGroqKey').placeholder = `Saved: ${s.GROQ_API_KEY.preview}`;
    }
    if (s.OPENROUTER_API_KEY && s.OPENROUTER_API_KEY.configured) {
      document.getElementById('inputOpenRouterKey').placeholder = `Saved: ${s.OPENROUTER_API_KEY.preview}`;
    }
    if (s.OLLAMA_HOST) {
      document.getElementById('inputOllamaHost').value = s.OLLAMA_HOST;
    }
  } catch (err) {
    console.error('Error loading settings:', err);
  }
}

document.getElementById('btnCopyAppKey')?.addEventListener('click', () => {
  const keyInput = document.getElementById('inputAppMasterKey');
  if (!keyInput || !keyInput.value) return;
  navigator.clipboard.writeText(keyInput.value);
  const btn = document.getElementById('btnCopyAppKey');
  btn.innerHTML = '<i data-lucide="check" class="w-2.5 h-2.5 text-emerald-400"></i> Copied!';
  lucide.createIcons();
  setTimeout(() => {
    btn.innerHTML = '<i data-lucide="copy" class="w-2.5 h-2.5"></i> Copy Key';
    lucide.createIcons();
  }, 2000);
});

document.getElementById('btnRegenAppKey')?.addEventListener('click', async () => {
  if (!confirm('Regenerate Application Master API Key? Any external webhook or script using the current key will need to be updated.')) return;
  try {
    const res = await fetch('/api/keys/regenerate', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      document.getElementById('inputAppMasterKey').value = data.appMasterKey;
      alert('New Application Master API Key generated and saved!');
    }
  } catch (err) {
    alert('Failed to regenerate key: ' + err.message);
  }
});

window.testKey = async function (provider) {
  const statusEl = document.getElementById(`testStatus_${provider}`);
  statusEl.classList.remove('hidden');
  statusEl.className = 'text-[10px] font-mono text-brand-300 animate-pulse';
  statusEl.innerText = 'Validating key connection...';

  let apiKey = '';
  let host = '';

  if (provider === 'gemini') apiKey = document.getElementById('inputGeminiKey').value.trim();
  if (provider === 'openai') apiKey = document.getElementById('inputOpenAIKey').value.trim();
  if (provider === 'groq') apiKey = document.getElementById('inputGroqKey').value.trim();
  if (provider === 'openrouter') apiKey = document.getElementById('inputOpenRouterKey').value.trim();
  if (provider === 'ollama') host = document.getElementById('inputOllamaHost').value.trim();

  try {
    const res = await fetch('/api/settings/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey, host })
    });
    const data = await res.json();

    if (data.success) {
      statusEl.className = 'text-[10px] font-mono text-emerald-400 font-bold';
      statusEl.innerText = `✓ Connected (${data.latency}ms): ${data.message}`;
    } else {
      statusEl.className = 'text-[10px] font-mono text-rose-400 font-semibold';
      statusEl.innerText = `✗ ${data.error || 'Connection failed.'}`;
    }
  } catch (err) {
    statusEl.className = 'text-[10px] font-mono text-rose-400';
    statusEl.innerText = `✗ Network error: ${err.message}`;
  }
};

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {};

  const gemini = document.getElementById('inputGeminiKey').value.trim();
  const openai = document.getElementById('inputOpenAIKey').value.trim();
  const groq = document.getElementById('inputGroqKey').value.trim();
  const openrouter = document.getElementById('inputOpenRouterKey').value.trim();
  const ollama = document.getElementById('inputOllamaHost').value.trim();

  if (gemini) payload.GEMINI_API_KEY = gemini;
  if (openai) payload.OPENAI_API_KEY = openai;
  if (groq) payload.GROQ_API_KEY = groq;
  if (openrouter) payload.OPENROUTER_API_KEY = openrouter;
  if (ollama) payload.OLLAMA_HOST = ollama;

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert('API keys and engine settings successfully saved to SQLite backend!');
      settingsModal.classList.add('hidden');
      await fetchStatus();
    }
  } catch (err) {
    alert('Failed to save settings: ' + err.message);
  }
});

// -------------------------------------------------------------
// Export Session
// -------------------------------------------------------------
btnExportChat.addEventListener('click', () => {
  window.open(`/api/export/${currentSessionId}?format=markdown`, '_blank');
});

// -------------------------------------------------------------
// Utility Helpers
// -------------------------------------------------------------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

window.copyToClipboard = function (btn) {
  const content = btn.getAttribute('data-content');
  if (!content) return;
  navigator.clipboard.writeText(content);
  btn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-emerald-400"></i>';
  lucide.createIcons();
  setTimeout(() => {
    btn.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i>';
    lucide.createIcons();
  }, 2000);
};

// -------------------------------------------------------------
// Deploy & Share Chatbot Modal Logic
// -------------------------------------------------------------
const deployModal = document.getElementById('deployModal');
const btnOpenDeploy = document.getElementById('btnOpenDeploy');
const btnCloseDeployModal = document.getElementById('btnCloseDeployModal');

btnOpenDeploy?.addEventListener('click', async () => {
  deployModal.classList.remove('hidden');
  try {
    const res = await fetch('/api/deployment-info');
    const data = await res.json();

    const publicChatUrl = `${window.location.origin}/chat`;
    const widgetSnippet = `<script src="${window.location.origin}/widget.js" data-title="Veritas AI"></script>`;
    const iframeSnippet = `<iframe src="${window.location.origin}/chat" width="420" height="650" style="border:none;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.3);"></iframe>`;

    document.getElementById('inputPublicChatUrl').value = publicChatUrl;
    document.getElementById('inputEmbedScript').value = widgetSnippet;
    document.getElementById('inputIframeCode').value = iframeSnippet;
    document.getElementById('linkOpenChat').href = publicChatUrl;

    if (data.phoneAccess) {
      const imgWifi = document.getElementById('imgPhoneWifiQr');
      const txtWifi = document.getElementById('txtPhoneWifiUrl');
      const imgPub = document.getElementById('imgPhonePublicQr');
      const txtPub = document.getElementById('txtPhonePublicUrl');

      if (imgWifi) imgWifi.src = data.phoneAccess.wifiQrCode;
      if (txtWifi) txtWifi.innerText = data.phoneAccess.wifiUrl;
      if (imgPub) imgPub.src = data.phoneAccess.publicQrCode;
      if (txtPub) txtPub.innerText = data.phoneAccess.publicUrl;
    }
  } catch (err) {
    console.error('Failed to load deployment info:', err);
  }
});

btnCloseDeployModal?.addEventListener('click', () => {
  deployModal.classList.add('hidden');
});

window.copyDeployText = function (inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const val = el.value || el.innerText || el.textContent;
  if (!val) return;
  navigator.clipboard.writeText(val.trim());
  alert('Copied: ' + val.trim());
};

// Start application
init();

