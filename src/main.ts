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

type ModelProvider = {
  id: string;
  name: string;
  base_url: string;
  default_model: string;
  active: boolean;
  connected: boolean;
};

type ModelProviderList = {
  providers: ModelProvider[];
};

type StoredChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  thinking?: string;
  provider?: string;
  model?: string;
};

type ChatHistoryRow = {
  chatId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

type ChatHistoryPayload = {
  chatId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredChatMessage[];
};

type ChatHistoryList = {
  folder: string;
  chats: ChatHistoryRow[];
};

type ChatMeta = Pick<ChatHistoryPayload, 'chatId' | 'name' | 'createdAt' | 'updatedAt'>;

const INLINE_MARKDOWN_PATTERN =
  /(?:`([^`]+)`)|(?:\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(?:\*\*([^*]+)\*\*)|(?:__([^_]+)__)|(?:\*([^*]+)\*)|(?:_([^_]+)_)/g;
const MAX_MARKDOWN_RENDER_LENGTH = 20000;
const MAX_MARKDOWN_RENDER_LINES = 500;
const MAX_MARKDOWN_TABLE_ROWS = 40;
const MAX_MARKDOWN_TABLE_COLUMNS = 8;

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app root');
}

app.innerHTML = `
  <main class="app-shell pre-chat is-booting sidebar-open" aria-label="Raynard">
    <section class="boot-overlay" role="status" aria-live="polite" aria-label="Starting Raynard">
      <div class="boot-overlay-inner">
        <div class="brand-mark" aria-hidden="true">n</div>
        <p class="boot-overlay-brand">raynard</p>
        <div class="boot-overlay-spinner" aria-hidden="true"></div>
      </div>
    </section>

    <aside id="sidebarRail" class="sidebar-rail" aria-label="Sidebar">
      <button id="chatsToggle" class="sidebar-rail-btn is-active" type="button" aria-label="Toggle chats sidebar" aria-pressed="true">
        ${iconSvg('message-square')}
      </button>
      <button id="newChatRail" class="sidebar-rail-btn" type="button" aria-label="New chat">
        ${iconSvg('plus')}
      </button>
    </aside>

    <aside id="chatSidebar" class="chat-sidebar is-open" aria-label="Chats">
      <header class="chat-sidebar-header">
        <h2>Chats</h2>
        <button id="sidebarClose" type="button" aria-label="Collapse chats sidebar">${iconSvg('panel-left-close')}</button>
      </header>
      <button id="newChatButton" class="new-chat-button" type="button">
        ${iconSvg('plus')}
        <span>New chat</span>
      </button>
      <nav id="chatHistoryList" class="chat-history-list" aria-label="Chat history"></nav>
      <p id="chatHistoryStatus" class="chat-history-status"></p>
    </aside>

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

      <div id="slashMenu" class="slash-menu is-hidden" aria-hidden="true">
        <button type="button" class="slash-menu-item" data-command="/models">
          <span class="slash-menu-command">/models</span>
          <span class="slash-menu-description">Connect or switch model providers</span>
        </button>
      </div>

      <section id="modelsModal" class="models-modal-overlay is-hidden" aria-hidden="true">
        <div class="models-modal" role="dialog" aria-modal="true" aria-labelledby="modelsModalTitle">
          <header class="models-modal-header">
            <div>
              <h2 id="modelsModalTitle">Model Providers</h2>
              <p id="modelsModalHint">Select a provider.</p>
            </div>
            <button id="modelsModalClose" type="button" aria-label="Close model providers">x</button>
          </header>
          <div id="modelsModalContent" class="models-modal-content"></div>
        </div>
      </section>
    </section>
  </main>
`;

const shell = document.querySelector<HTMLElement>('.app-shell');
const chatsToggle = document.querySelector<HTMLButtonElement>('#chatsToggle');
const newChatRail = document.querySelector<HTMLButtonElement>('#newChatRail');
const chatSidebar = document.querySelector<HTMLElement>('#chatSidebar');
const sidebarClose = document.querySelector<HTMLButtonElement>('#sidebarClose');
const newChatButton = document.querySelector<HTMLButtonElement>('#newChatButton');
const chatHistoryList = document.querySelector<HTMLElement>('#chatHistoryList');
const chatHistoryStatus = document.querySelector<HTMLElement>('#chatHistoryStatus');
const introForm = document.querySelector<HTMLFormElement>('#introForm');
const introInput = document.querySelector<HTMLTextAreaElement>('#introInput');
const introEnvLabel = document.querySelector<HTMLElement>('#introEnvLabel');
const messages = document.querySelector<HTMLElement>('#messages');
const chatForm = document.querySelector<HTMLFormElement>('#chatForm');
const chatInput = document.querySelector<HTMLTextAreaElement>('#chatInput');
const chatEnvLabel = document.querySelector<HTMLElement>('#chatEnvLabel');
const suggestionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-suggestion]'));
const slashMenu = document.querySelector<HTMLElement>('#slashMenu');
const slashMenuItem = document.querySelector<HTMLButtonElement>('[data-command="/models"]');
const modelsModal = document.querySelector<HTMLElement>('#modelsModal');
const modelsModalTitle = document.querySelector<HTMLElement>('#modelsModalTitle');
const modelsModalHint = document.querySelector<HTMLElement>('#modelsModalHint');
const modelsModalContent = document.querySelector<HTMLElement>('#modelsModalContent');
const modelsModalClose = document.querySelector<HTMLButtonElement>('#modelsModalClose');

let activeSessionId = createSessionId();
let activeChatMeta = createChatMeta(activeSessionId);
let chatMessages: ChatMessage[] = [];
let storedMessages: StoredChatMessage[] = [];
let chatHistoryRows: ChatHistoryRow[] = [];
let isRunning = false;
let modelProviders: ModelProvider[] = [];

window.setTimeout(() => {
  shell?.classList.remove('is-booting');
  introInput?.focus();
}, 650);

loadEnvStatus().catch(() => {
  setEnvLabel('no .env loaded');
});
void refreshChatHistory();

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
  input?.addEventListener('input', () => {
    syncSlashMenu(input);
  });

  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSlashMenu();
      closeModelsModal();
      return;
    }

    if (event.key === 'Enter' && slashMenu && !slashMenu.classList.contains('is-hidden')) {
      event.preventDefault();
      void openModelsCommandFlow(input);
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const target = event.currentTarget;
    if (target instanceof HTMLTextAreaElement) {
      void submitMessage(target);
    }
  });
}

slashMenuItem?.addEventListener('click', () => {
  const input = shell?.classList.contains('pre-chat') ? introInput : chatInput;
  void openModelsCommandFlow(input ?? null);
});

modelsModalClose?.addEventListener('click', () => closeModelsModal());
modelsModal?.addEventListener('click', (event) => {
  if (event.target === modelsModal) {
    closeModelsModal();
  }
});

chatsToggle?.addEventListener('click', () => {
  setSidebarOpen(!shell?.classList.contains('sidebar-open'));
});

sidebarClose?.addEventListener('click', () => setSidebarOpen(false));
newChatButton?.addEventListener('click', () => void startNewConversation({ showPreChat: true }));
newChatRail?.addEventListener('click', () => void startNewConversation({ showPreChat: true }));

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

function iconSvg(name: string) {
  const icons: Record<string, string> = {
    'message-square':
      '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
    plus: '<path d="M5 12h14"></path><path d="M12 5v14"></path>',
    'panel-left-close':
      '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path><path d="m16 15-3-3 3-3"></path>',
    'trash-2':
      '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>'
  };

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      ${icons[name] ?? icons['message-square']}
    </svg>
  `;
}

function setEnvLabel(label: string) {
  if (introEnvLabel) introEnvLabel.textContent = label;
  if (chatEnvLabel) chatEnvLabel.textContent = label;
}

function syncSlashMenu(input: HTMLTextAreaElement | null) {
  if (!input || !slashMenu) return;
  const value = input.value.trim();
  if (!value || !'/models'.startsWith(value) || !value.startsWith('/')) {
    hideSlashMenu();
    return;
  }

  const rect = input.getBoundingClientRect();
  slashMenu.style.left = `${Math.round(rect.left)}px`;
  slashMenu.style.width = `${Math.round(rect.width)}px`;
  slashMenu.style.top = `${Math.max(8, Math.round(rect.top - 62))}px`;
  slashMenu.classList.remove('is-hidden');
  slashMenu.setAttribute('aria-hidden', 'false');
}

function hideSlashMenu() {
  slashMenu?.classList.add('is-hidden');
  slashMenu?.setAttribute('aria-hidden', 'true');
}

async function openModelsCommandFlow(input: HTMLTextAreaElement | null) {
  if (input) input.value = '';
  hideSlashMenu();
  openModelsModal();
  renderModelsLoading();

  try {
    const result = await invoke<ModelProviderList>('list_model_providers');
    modelProviders = result.providers;
    renderProviderList();
  } catch (error) {
    renderModelsError(getErrorMessage(error, 'Could not load providers.'));
  }
}

function openModelsModal() {
  modelsModal?.classList.remove('is-hidden');
  modelsModal?.setAttribute('aria-hidden', 'false');
}

function closeModelsModal() {
  modelsModal?.classList.add('is-hidden');
  modelsModal?.setAttribute('aria-hidden', 'true');
}

function renderModelsLoading() {
  if (modelsModalTitle) modelsModalTitle.textContent = 'Model Providers';
  if (modelsModalHint) modelsModalHint.textContent = 'Loading providers...';
  if (modelsModalContent) {
    modelsModalContent.innerHTML = '<p class="models-modal-empty">Loading...</p>';
  }
}

function renderModelsError(message: string) {
  if (modelsModalTitle) modelsModalTitle.textContent = 'Model Providers';
  if (modelsModalHint) modelsModalHint.textContent = message;
  if (modelsModalContent) {
    modelsModalContent.innerHTML = '';
  }
}

function renderProviderList() {
  if (!modelsModalContent) return;
  if (modelsModalTitle) modelsModalTitle.textContent = 'Model Providers';
  if (modelsModalHint) modelsModalHint.textContent = 'Select a provider.';
  modelsModalContent.innerHTML = '';

  for (const provider of modelProviders) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `models-provider-row${provider.active ? ' is-active' : ''}`;
    button.innerHTML = `
      <span class="models-provider-icon" aria-hidden="true">${providerIcon(provider.id)}</span>
      <span class="models-provider-main">
        <strong>${escapeHtml(provider.name)}</strong>
        <span>${escapeHtml(provider.default_model)} · ${escapeHtml(provider.base_url.replace(/^https?:\/\//, ''))}</span>
      </span>
      <span class="models-provider-state${provider.active ? ' is-active' : ''}">
        ${provider.connected ? (provider.active ? 'Active' : 'Saved') : 'Add key'}
      </span>
      <span class="models-provider-chevron" aria-hidden="true">›</span>
    `;
    button.addEventListener('click', () => {
      if (provider.connected) {
        void selectProvider(provider);
      } else {
        renderApiKeyStep(provider);
      }
    });
    modelsModalContent.appendChild(button);
  }
}

async function selectProvider(provider: ModelProvider) {
  try {
    const result = await invoke<ModelProviderList>('set_active_provider', { providerId: provider.id });
    modelProviders = result.providers;
    const active = modelProviders.find((item) => item.active);
    setEnvLabel(active ? `${active.id}/${active.default_model}` : `${provider.id}/${provider.default_model}`);
    closeModelsModal();
  } catch (error) {
    if (modelsModalHint) modelsModalHint.textContent = getErrorMessage(error, `Could not select ${provider.name}.`);
  }
}

function renderApiKeyStep(provider: ModelProvider) {
  if (!modelsModalContent) return;
  if (modelsModalTitle) modelsModalTitle.textContent = provider.name;
  if (modelsModalHint) modelsModalHint.textContent = 'Paste your API key. It will be saved in the OS keychain.';
  modelsModalContent.innerHTML = '';

  const form = document.createElement('form');
  form.className = 'models-key-form';
  form.autocomplete = 'off';

  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'models-key-input';
  input.placeholder = `${provider.name} API key`;
  input.spellcheck = false;
  input.autocomplete = 'off';
  form.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'models-modal-actions';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'models-secondary-action';
  back.textContent = 'Back';
  back.addEventListener('click', () => renderProviderList());
  actions.appendChild(back);

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'models-primary-action';
  save.textContent = 'Save';
  actions.appendChild(save);
  form.appendChild(actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const apiKey = input.value.trim();
    if (!apiKey) {
      if (modelsModalHint) modelsModalHint.textContent = 'API key is required.';
      return;
    }
    try {
      const result = await invoke<ModelProviderList>('save_provider_api_key', {
        providerId: provider.id,
        apiKey
      });
      input.value = '';
      modelProviders = result.providers;
      const active = modelProviders.find((item) => item.active);
      setEnvLabel(active ? `${active.id}/${active.default_model}` : `${provider.id}/${provider.default_model}`);
      closeModelsModal();
    } catch (error) {
      if (modelsModalHint) modelsModalHint.textContent = getErrorMessage(error, `Could not save ${provider.name} key.`);
    }
  });

  modelsModalContent.appendChild(form);
  setTimeout(() => input.focus(), 0);
}

function providerIcon(providerId: string) {
  if (providerId === 'openai') return 'O';
  if (providerId === 'claude') return 'C';
  return 'K';
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function createSessionId() {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `chat-${Date.now().toString(36)}-${random[0].toString(36)}${random[1].toString(36)}`;
}

function createChatMeta(chatId: string, seedPrompt = ''): ChatMeta {
  const now = new Date().toISOString();
  return {
    chatId,
    name: createChatNameFromPrompt(seedPrompt),
    createdAt: now,
    updatedAt: now
  };
}

function createChatNameFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Untitled chat';
  return normalized.length > 44 ? `${normalized.slice(0, 43).trimEnd()}...` : normalized;
}

function ensureActiveChatMeta(seedPrompt = '') {
  if (!activeChatMeta) {
    activeSessionId = createSessionId();
    activeChatMeta = createChatMeta(activeSessionId, seedPrompt);
  }

  if (activeChatMeta.name === 'Untitled chat' && seedPrompt.trim()) {
    activeChatMeta = {
      ...activeChatMeta,
      name: createChatNameFromPrompt(seedPrompt)
    };
  }

  return activeChatMeta;
}

function setSidebarOpen(open: boolean) {
  shell?.classList.toggle('sidebar-open', open);
  chatSidebar?.classList.toggle('is-open', open);
  chatsToggle?.setAttribute('aria-pressed', String(open));
}

async function refreshChatHistory() {
  try {
    const result = await invoke<ChatHistoryList>('list_chat_history');
    chatHistoryRows = result.chats;
    renderChatHistory();
    if (chatHistoryStatus) {
      chatHistoryStatus.textContent = chatHistoryRows.length ? '' : 'No saved chats yet.';
    }
  } catch (error) {
    if (chatHistoryStatus) {
      chatHistoryStatus.textContent = getErrorMessage(error, 'Could not load chats.');
    }
  }
}

function renderChatHistory() {
  if (!chatHistoryList) return;
  chatHistoryList.innerHTML = '';

  for (const chat of chatHistoryRows) {
    const row = document.createElement('div');
    row.className = `chat-history-row${chat.chatId === activeSessionId ? ' is-active' : ''}`;

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'chat-history-open';
    openButton.innerHTML = `
      <span class="chat-history-title">${escapeHtml(chat.name)}</span>
      <span class="chat-history-meta">${formatChatDate(chat.updatedAt)} · ${chat.messageCount} messages</span>
    `;
    openButton.addEventListener('click', () => void openSavedChat(chat.chatId));
    row.appendChild(openButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'chat-history-delete';
    deleteButton.setAttribute('aria-label', `Delete ${chat.name}`);
    deleteButton.innerHTML = iconSvg('trash-2');
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void deleteSavedChat(chat.chatId);
    });
    row.appendChild(deleteButton);

    chatHistoryList.appendChild(row);
  }
}

function formatChatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

async function persistActiveChatHistory() {
  if (!storedMessages.length) return;
  const meta = ensureActiveChatMeta(storedMessages[0]?.text ?? '');
  meta.updatedAt = new Date().toISOString();
  await invoke<ChatHistoryRow>('save_chat_history', {
    payload: {
      ...meta,
      messages: storedMessages
    }
  });
}

async function openSavedChat(chatId: string) {
  if (isRunning || !messages) return;
  await persistActiveChatHistory();

  const chat = await invoke<ChatHistoryPayload>('read_chat_history', { chatId });
  activeSessionId = chat.chatId;
  activeChatMeta = {
    chatId: chat.chatId,
    name: chat.name,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  };
  storedMessages = chat.messages;
  chatMessages = storedMessages.map((message) => ({
    role: message.role,
    content: message.text
  }));

  messages.innerHTML = '';
  for (const message of storedMessages) {
    renderStoredMessage(message);
  }

  showConversation();
  renderChatHistory();
  chatInput?.focus();
}

async function deleteSavedChat(chatId: string) {
  await invoke('delete_chat_history', { chatId });
  if (chatId === activeSessionId) {
    resetConversationState();
    messages?.replaceChildren();
    shell?.classList.add('pre-chat');
  }
  await refreshChatHistory();
}

async function startNewConversation(options: { showPreChat: boolean }) {
  if (isRunning) return;
  await persistActiveChatHistory();
  resetConversationState();
  messages?.replaceChildren();
  if (options.showPreChat) {
    shell?.classList.add('pre-chat');
    introInput?.focus();
  } else {
    showConversation();
    chatInput?.focus();
  }
  await refreshChatHistory();
}

function resetConversationState() {
  activeSessionId = createSessionId();
  activeChatMeta = createChatMeta(activeSessionId);
  chatMessages = [];
  storedMessages = [];
}

function renderStoredMessage(message: StoredChatMessage) {
  addMessage(message.role, message.text, false, message.role === 'assistant');
}

async function submitMessage(input: HTMLTextAreaElement | null) {
  if (!input || !messages || isRunning) return;

  const content = input.value.trim();
  if (!content) return;
  if (content === '/models') {
    await openModelsCommandFlow(input);
    return;
  }

  input.value = '';
  showConversation();
  ensureActiveChatMeta(content);
  addMessage('user', content);
  chatMessages.push({ role: 'user', content });
  storedMessages.push({
    role: 'user',
    text: content,
    timestamp: Date.now()
  });
  await persistActiveChatHistory();
  await refreshChatHistory();

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
      renderMessageText(pendingBody, reply.content || streamed || 'The model returned an empty response.', true);
    }
    pending.classList.remove('pending');
    const finalContent = reply.content || streamed || 'The model returned an empty response.';
    chatMessages.push({ role: 'assistant', content: finalContent });
    storedMessages.push({
      role: 'assistant',
      text: finalContent,
      timestamp: Date.now(),
      thinking: thinking.trim() || undefined,
      provider: reply.provider,
      model: reply.model
    });
    await persistActiveChatHistory();
    await refreshChatHistory();
    if (reply.provider && reply.model) {
      setEnvLabel(`${reply.provider}/${reply.model}`);
    }
  } catch (error) {
    pending.remove();
    const errorMessage = getErrorMessage(error);
    addMessage('assistant', errorMessage);
    storedMessages.push({
      role: 'assistant',
      text: errorMessage,
      timestamp: Date.now(),
      thinking: thinking.trim() || undefined
    });
    await persistActiveChatHistory();
    await refreshChatHistory();
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

function addMessage(role: ChatMessage['role'], content: string, pending = false, markdown = false) {
  if (!messages) {
    throw new Error('Missing messages container');
  }

  const article = document.createElement('article');
  article.className = `message ${role}${pending ? ' pending' : ''}`;

  const body = document.createElement('div');
  body.className = 'message-text';
  renderMessageText(body, content, markdown);

  article.appendChild(body);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;

  return article;
}

function renderMessageText(container: HTMLElement, text: string, markdown = false) {
  if (!markdown) {
    container.textContent = text;
    return;
  }

  renderMarkdown(container, text);
  if (!container.childNodes.length) {
    container.textContent = text;
  }
}

function renderMarkdown(container: HTMLElement, text: string) {
  container.textContent = '';
  const sourceText = String(text || '');
  const sourceLines = sourceText.replace(/\r\n?/g, '\n').split('\n');

  if (sourceText.length > MAX_MARKDOWN_RENDER_LENGTH || sourceLines.length > MAX_MARKDOWN_RENDER_LINES) {
    container.textContent = sourceText;
    return;
  }

  renderMarkdownLightweight(container, sourceText, sourceLines);
}

function renderMarkdownLightweight(container: HTMLElement, sourceText: string, sourceLines: string[]) {
  let index = 0;
  let guard = 0;

  while (index < sourceLines.length) {
    guard += 1;
    if (guard > sourceLines.length * 8 + 32) {
      container.textContent = sourceText;
      return;
    }

    const line = sourceLines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const block: string[] = [];
      const language = trimmed.slice(3).trim();
      index += 1;
      while (index < sourceLines.length && !sourceLines[index].trim().startsWith('```')) {
        block.push(sourceLines[index]);
        index += 1;
      }
      if (index < sourceLines.length) {
        index += 1;
      }
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (language) {
        code.dataset.language = language;
      }
      code.textContent = block.join('\n');
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      const heading = document.createElement(`h${level}`);
      appendInlineMarkdownSafe(heading, headingMatch[2]);
      container.appendChild(heading);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < sourceLines.length && /^>\s?/.test(sourceLines[index].trim())) {
        quoteLines.push(sourceLines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      const blockquote = document.createElement('blockquote');
      const paragraph = document.createElement('p');
      appendInlineMarkdownSafe(paragraph, quoteLines.join(' '));
      blockquote.appendChild(paragraph);
      container.appendChild(blockquote);
      continue;
    }

    if (isMarkdownTableRowLine(trimmed) && index + 1 < sourceLines.length && isMarkdownTableDivider(sourceLines[index + 1])) {
      const headerCells = splitMarkdownTableRow(trimmed);
      if (!headerCells.length || headerCells.length > MAX_MARKDOWN_TABLE_COLUMNS) {
        const pre = document.createElement('pre');
        pre.textContent = trimmed;
        container.appendChild(pre);
        index += 1;
        continue;
      }

      const alignments = parseMarkdownTableAlignment(sourceLines[index + 1]);
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      headerCells.forEach((cellText, cellIndex) => {
        const cell = document.createElement('th');
        if (alignments[cellIndex]) {
          cell.style.textAlign = alignments[cellIndex];
        }
        appendInlineMarkdownSafe(cell, cellText);
        headerRow.appendChild(cell);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      index += 2;
      let rowCount = 0;
      while (index < sourceLines.length && isMarkdownTableRowLine(sourceLines[index]) && rowCount < MAX_MARKDOWN_TABLE_ROWS) {
        const rowCells = splitMarkdownTableRow(sourceLines[index]);
        if (!rowCells.length) break;
        const row = document.createElement('tr');
        rowCells.slice(0, headerCells.length).forEach((cellText, cellIndex) => {
          const cell = document.createElement('td');
          if (alignments[cellIndex]) {
            cell.style.textAlign = alignments[cellIndex];
          }
          appendInlineMarkdownSafe(cell, cellText);
          row.appendChild(cell);
        });
        while (row.childElementCount < headerCells.length) {
          row.appendChild(document.createElement('td'));
        }
        tbody.appendChild(row);
        index += 1;
        rowCount += 1;
      }
      if (index < sourceLines.length && isMarkdownTableRowLine(sourceLines[index])) {
        const overflowRow = document.createElement('tr');
        const overflowCell = document.createElement('td');
        overflowCell.colSpan = headerCells.length;
        overflowCell.textContent = `Table truncated after ${MAX_MARKDOWN_TABLE_ROWS} rows.`;
        overflowRow.appendChild(overflowCell);
        tbody.appendChild(overflowRow);
        while (index < sourceLines.length && isMarkdownTableRowLine(sourceLines[index])) {
          index += 1;
        }
      }
      table.appendChild(tbody);
      container.appendChild(table);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < sourceLines.length) {
        const listLine = sourceLines[index].trim();
        const markerPattern = ordered ? /^\d+\.\s+/ : /^[-*+]\s+/;
        if (!markerPattern.test(listLine)) break;
        const item = document.createElement('li');
        appendInlineMarkdownSafe(item, listLine.replace(markerPattern, ''));
        list.appendChild(item);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      container.appendChild(document.createElement('hr'));
      index += 1;
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < sourceLines.length && !isMarkdownBlockBoundary(sourceLines[index])) {
      paragraphLines.push(sourceLines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement('p');
    appendInlineMarkdownSafe(paragraph, paragraphLines.join(' '));
    container.appendChild(paragraph);
  }
}

function appendInlineMarkdownSafe(container: HTMLElement, text: string) {
  const source = String(text || '');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_MARKDOWN_PATTERN.lastIndex = 0;

  while ((match = INLINE_MARKDOWN_PATTERN.exec(source))) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
    }

    if (match[1]) {
      const code = document.createElement('code');
      code.textContent = match[1];
      container.appendChild(code);
    } else if (match[2] && match[3]) {
      const link = document.createElement('a');
      link.href = match[3];
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = match[2];
      container.appendChild(link);
    } else if (match[4] || match[5]) {
      const strong = document.createElement('strong');
      strong.textContent = match[4] || match[5];
      container.appendChild(strong);
    } else if (match[6] || match[7]) {
      const emphasis = document.createElement('em');
      emphasis.textContent = match[6] || match[7];
      container.appendChild(emphasis);
    }

    lastIndex = INLINE_MARKDOWN_PATTERN.lastIndex;
  }

  if (lastIndex < source.length) {
    container.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
}

function isMarkdownBlockBoundary(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return (
    trimmed.startsWith('```') ||
    /^#{1,6}\s+/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^[-*+]\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed) ||
    /^-{3,}$/.test(trimmed) ||
    isMarkdownTableRowLine(trimmed)
  );
}

function isMarkdownTableRowLine(line: string) {
  return splitMarkdownTableRow(line).length >= 2;
}

function splitMarkdownTableRow(line: string) {
  let trimmed = String(line || '').trim();
  if (!trimmed || !trimmed.includes('|')) return [];
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|')) {
    trimmed = trimmed.slice(0, -1);
  }
  if (!trimmed.includes('|')) return [];
  const cells = trimmed.split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : [];
}

function isMarkdownTableDivider(line: string) {
  const cells = splitMarkdownTableRow(line);
  if (!cells.length) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTableAlignment(line: string) {
  return splitMarkdownTableRow(line).map((cell) => {
    const startsWithColon = cell.startsWith(':');
    const endsWithColon = cell.endsWith(':');
    if (startsWithColon && endsWithColon) return 'center';
    if (endsWithColon) return 'right';
    if (startsWithColon) return 'left';
    return '';
  });
}
