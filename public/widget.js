(function () {
  // Prevent duplicate injection
  if (window.VeritasWidgetInitialized) return;
  window.VeritasWidgetInitialized = true;

  // Determine API base URL from current script tag
  const currentScript = document.currentScript || (function () {
    const scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  const scriptSrc = currentScript ? currentScript.src : '';
  let apiBase = '';
  try {
    const url = new URL(scriptSrc);
    apiBase = `${url.protocol}//${url.host}`;
  } catch (e) {
    apiBase = window.location.origin;
  }
  if (currentScript && currentScript.getAttribute('data-api')) {
    apiBase = currentScript.getAttribute('data-api');
  }

  const widgetTitle = (currentScript && currentScript.getAttribute('data-title')) || 'Veritas AI';

  // Retrieve or create persistent guest session ID
  let widgetSessionId = localStorage.getItem('vpro_widget_session');
  if (!widgetSessionId) {
    widgetSessionId = 'widget_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    localStorage.setItem('vpro_widget_session', widgetSessionId);
  }

  // Inject Styles
  const style = document.createElement('style');
  style.textContent = `
    .vpro-bubble {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 58px;
      height: 58px;
      border-radius: 29px;
      background: linear-gradient(135deg, #4f46e5 0%, #6366f1 50%, #38bdf8 100%);
      box-shadow: 0 10px 25px -5px rgba(79, 70, 229, 0.5), 0 8px 10px -6px rgba(79, 70, 229, 0.4);
      cursor: pointer;
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      border: 2px solid rgba(255, 255, 255, 0.2);
    }
    .vpro-bubble:hover {
      transform: scale(1.08) translateY(-2px);
      box-shadow: 0 14px 28px -4px rgba(79, 70, 229, 0.6);
    }
    .vpro-bubble svg {
      width: 28px;
      height: 28px;
      color: #ffffff;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .vpro-window {
      position: fixed;
      bottom: 96px;
      right: 24px;
      width: 380px;
      max-width: calc(100vw - 32px);
      height: 560px;
      max-height: calc(100vh - 120px);
      background: #090d16;
      border: 1px solid rgba(51, 65, 85, 0.7);
      border-radius: 20px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(99, 102, 241, 0.15);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #f8fafc;
      opacity: 0;
      transform: translateY(20px) scale(0.95);
      pointer-events: none;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .vpro-window.open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .vpro-header {
      background: #0f172a;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(51, 65, 85, 0.6);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .vpro-header-info {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .vpro-avatar {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      background: linear-gradient(135deg, #4f46e5, #06b6d4);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .vpro-avatar svg {
      width: 18px;
      height: 18px;
      color: white;
    }
    .vpro-title {
      font-size: 13px;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.2;
    }
    .vpro-status {
      font-size: 10px;
      color: #10b981;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .vpro-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
    }
    .vpro-close-btn {
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      padding: 4px;
      border-radius: 6px;
      display: flex;
      align-items: center;
    }
    .vpro-close-btn:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.1);
    }
    .vpro-body {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-size: 12px;
      line-height: 1.5;
    }
    .vpro-msg {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 14px;
      word-break: break-word;
    }
    .vpro-msg.user {
      align-self: flex-end;
      background: linear-gradient(135deg, #4f46e5, #6366f1);
      color: #ffffff;
      border-bottom-right-radius: 2px;
    }
    .vpro-msg.bot {
      align-self: flex-start;
      background: #1e293b;
      color: #e2e8f0;
      border-bottom-left-radius: 2px;
      border: 1px solid rgba(51, 65, 85, 0.5);
    }
    .vpro-msg p { margin: 0 0 6px 0; }
    .vpro-msg p:last-child { margin: 0; }
    .vpro-msg code { background: rgba(0, 0, 0, 0.3); padding: 2px 4px; border-radius: 4px; font-size: 0.9em; }
    .vpro-footer {
      padding: 10px 12px;
      border-top: 1px solid rgba(51, 65, 85, 0.6);
      background: #0b1120;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .vpro-input {
      flex: 1;
      background: #1e293b;
      border: 1px solid rgba(51, 65, 85, 0.8);
      border-radius: 10px;
      padding: 9px 12px;
      font-size: 12px;
      color: #ffffff;
      outline: none;
      transition: border-color 0.2s;
    }
    .vpro-input:focus {
      border-color: #6366f1;
    }
    .vpro-send-btn {
      background: #4f46e5;
      border: none;
      border-radius: 10px;
      padding: 8px 12px;
      color: #ffffff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }
    .vpro-send-btn:hover {
      background: #4338ca;
    }
  `;
  document.head.appendChild(style);

  // Inject Floating Bubble
  const bubble = document.createElement('div');
  bubble.className = 'vpro-bubble';
  bubble.title = 'Chat with ' + widgetTitle;
  bubble.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
    </svg>
  `;
  document.body.appendChild(bubble);

  // Inject Window
  const win = document.createElement('div');
  win.className = 'vpro-window';
  win.innerHTML = `
    <div class="vpro-header">
      <div class="vpro-header-info">
        <div class="vpro-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        </div>
        <div>
          <div class="vpro-title">${widgetTitle}</div>
          <div class="vpro-status"><span class="vpro-dot"></span> Online • Autonomous Copilot</div>
        </div>
      </div>
      <button class="vpro-close-btn" id="vproCloseBtn" title="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
    <div class="vpro-body" id="vproBody">
      <div class="vpro-msg bot">
        👋 Hi! How can I help you today? I can answer questions, calculate formulas, or look up information for you.
      </div>
    </div>
    <form class="vpro-footer" id="vproForm">
      <input type="text" class="vpro-input" id="vproInput" placeholder="Type a question or 'hi'..." autocomplete="off" required>
      <button type="submit" class="vpro-send-btn" id="vproSendBtn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
      </button>
    </form>
  `;
  document.body.appendChild(win);

  // Event Listeners
  let isOpen = false;
  bubble.addEventListener('click', () => {
    isOpen = !isOpen;
    if (isOpen) {
      win.classList.add('open');
      document.getElementById('vproInput').focus();
    } else {
      win.classList.remove('open');
    }
  });

  document.getElementById('vproCloseBtn').addEventListener('click', () => {
    isOpen = false;
    win.classList.remove('open');
  });

  const vproBody = document.getElementById('vproBody');
  const vproForm = document.getElementById('vproForm');
  const vproInput = document.getElementById('vproInput');
  const vproSendBtn = document.getElementById('vproSendBtn');

  function appendMsg(role, text) {
    const el = document.createElement('div');
    el.className = `vpro-msg ${role}`;
    el.innerHTML = text.replace(/\n/g, '<br>');
    vproBody.appendChild(el);
    vproBody.scrollTop = vproBody.scrollHeight;
  }

  vproForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = vproInput.value.trim();
    if (!message) return;

    appendMsg('user', message);
    vproInput.value = '';
    vproInput.disabled = true;
    vproSendBtn.disabled = true;

    // Loading indicator
    const typing = document.createElement('div');
    typing.className = 'vpro-msg bot';
    typing.id = 'vproTyping';
    typing.innerText = 'Thinking...';
    vproBody.appendChild(typing);
    vproBody.scrollTop = vproBody.scrollHeight;

    try {
      const res = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: widgetSessionId,
          message: message,
          persona: 'general'
        })
      });
      const data = await res.json();
      const typingEl = document.getElementById('vproTyping');
      if (typingEl) typingEl.remove();

      appendMsg('bot', data.response || data.error || 'No response received.');
    } catch (err) {
      const typingEl = document.getElementById('vproTyping');
      if (typingEl) typingEl.remove();
      appendMsg('bot', '⚠️ Connection error. Please check server status.');
    } finally {
      vproInput.disabled = false;
      vproSendBtn.disabled = false;
      vproInput.focus();
    }
  });

})();
