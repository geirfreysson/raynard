import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errors';
import { runAgentTurnStream, type ChatMessage } from './agent-runtime';
import './styles.css';

type LlmEnvStatus = {
  found: boolean;
  path: string | null;
  keys: string[];
  provider: string;
  model: string;
  configured: boolean;
};

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app root');
}

app.innerHTML = `
  <main class="app-shell pre-chat is-booting" aria-label="Raynard">
    <section class="boot-overlay" role="status" aria-live="polite" aria-label="Starting Raynard">
      <div class="boot-overlay-inner">
        <div class="brand-mark" aria-hidden="true">n</div>
        <p class="boot-overlay-brand">raynard</p>
        <div class="boot-overlay-spinner" aria-hidden="true"></div>
      </div>
    </section>

    <section class="chat-shell">
      <section class="intro-stage">
        <div class="intro-logo" aria-hidden="true">
          <div class="brand-mark">n</div>
          <span>raynard</span>
        </div>

        <section class="intro-suggestions" aria-label="Prompt suggestions">
          <button type="button" data-suggestion="Start a lightweight research conversation">
            Start a lightweight research conversation
          </button>
          <button type="button" data-suggestion="Summarize what this barebones app can do">
            Summarize what this barebones app can do
          </button>
          <button type="button" data-suggestion="Say hello and show the conversation view">
            Say hello and show the conversation view
          </button>
        </section>

        <form id="introForm" class="intro-composer" autocomplete="off">
          <textarea id="introInput" placeholder="Ask anything ..." rows="2"></textarea>
          <div class="composer-meta-row">
            <span id="introEnvLabel" class="composer-model-label">checking .env</span>
          </div>
        </form>
      </section>

      <section id="messages" class="messages" aria-live="polite"></section>

      <form id="chatForm" class="composer" autocomplete="off">
        <textarea id="chatInput" rows="1"></textarea>
        <div class="composer-meta-row">
          <span id="chatEnvLabel" class="composer-model-label">hello-world runtime</span>
        </div>
      </form>
    </section>
  </main>
`;

const shell = document.querySelector<HTMLElement>('.app-shell');
const introForm = document.querySelector<HTMLFormElement>('#introForm');
const introInput = document.querySelector<HTMLTextAreaElement>('#introInput');
const introEnvLabel = document.querySelector<HTMLElement>('#introEnvLabel');
const messages = document.querySelector<HTMLElement>('#messages');
const chatForm = document.querySelector<HTMLFormElement>('#chatForm');
const chatInput = document.querySelector<HTMLTextAreaElement>('#chatInput');
const chatEnvLabel = document.querySelector<HTMLElement>('#chatEnvLabel');
const suggestionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-suggestion]'));

const chatMessages: ChatMessage[] = [];
let isRunning = false;

window.setTimeout(() => {
  shell?.classList.remove('is-booting');
  introInput?.focus();
}, 650);

loadEnvStatus().catch(() => {
  setEnvLabel('no .env loaded');
});

introForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitMessage(introInput);
});

chatForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitMessage(chatInput);
});

for (const button of suggestionButtons) {
  button.addEventListener('click', () => {
    if (!introInput) return;
    introInput.value = button.dataset.suggestion ?? '';
    introInput.focus();
  });
}

for (const input of [introInput, chatInput]) {
  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const target = event.currentTarget;
    if (target instanceof HTMLTextAreaElement) {
      void submitMessage(target);
    }
  });
}

async function loadEnvStatus() {
  const status = await invoke<LlmEnvStatus>('load_llm_env_status');
  if (!status.found) {
    setEnvLabel(`no .env loaded - ${status.provider}/${status.model}`);
    return;
  }

  const keyLabel = status.configured
    ? `${status.provider}/${status.model}`
    : `.env found - missing ${status.provider} key`;
  setEnvLabel(keyLabel);
}

function setEnvLabel(label: string) {
  if (introEnvLabel) introEnvLabel.textContent = label;
  if (chatEnvLabel) chatEnvLabel.textContent = label;
}

async function submitMessage(input: HTMLTextAreaElement | null) {
  if (!input || !messages || isRunning) return;

  const content = input.value.trim();
  if (!content) return;

  input.value = '';
  showConversation();
  addMessage('user', content);
  chatMessages.push({ role: 'user', content });

  const pending = addMessage('assistant', '', true);
  const pendingBody = pending.querySelector<HTMLElement>('.message-text');
  const thinkingPreview = document.createElement('div');
  thinkingPreview.className = 'thinking-preview';
  thinkingPreview.textContent = 'Thinking...';
  pending.prepend(thinkingPreview);
  let streamed = '';
  let thinking = '';
  isRunning = true;

  try {
    const reply = await runAgentTurnStream(chatMessages, {
      onDelta: (delta) => {
        streamed += delta;
        if (pendingBody) {
          pendingBody.textContent = streamed;
        }
        if (thinkingPreview.parentElement) {
          thinkingPreview.remove();
        }
        messages.scrollTop = messages.scrollHeight;
      },
      onThinkingDelta: (delta) => {
        thinking += delta;
        thinkingPreview.textContent = formatThinkingPreview(thinking);
        messages.scrollTop = messages.scrollHeight;
      }
    });
    if (thinkingPreview.parentElement) {
      thinkingPreview.remove();
    }
    if (pendingBody) {
      pendingBody.textContent = reply.content || streamed || 'The model returned an empty response.';
    }
    pending.classList.remove('pending');
    chatMessages.push({ role: 'assistant', content: reply.content });
    if (reply.provider && reply.model) {
      setEnvLabel(`${reply.provider}/${reply.model}`);
    }
  } catch (error) {
    pending.remove();
    addMessage('assistant', getErrorMessage(error));
  } finally {
    isRunning = false;
    chatInput?.focus();
  }
}

function formatThinkingPreview(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Thinking...';
  return `Thinking: ${normalized.slice(-220)}`;
}

function showConversation() {
  shell?.classList.remove('pre-chat');
}

function addMessage(role: ChatMessage['role'], content: string, pending = false) {
  if (!messages) {
    throw new Error('Missing messages container');
  }

  const article = document.createElement('article');
  article.className = `message ${role}${pending ? ' pending' : ''}`;

  const body = document.createElement('div');
  body.className = 'message-text';
  body.textContent = content;

  article.appendChild(body);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;

  return article;
}
