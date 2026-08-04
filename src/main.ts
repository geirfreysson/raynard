import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errors';
import {
  cancelAgentTurnStream,
  runAgentTurnStream,
  runPluginBuilderStream,
  type ChatMessage
} from './agent-runtime';
import { detectCapabilityRequest, type CapabilityRequest } from './plugin-capabilities';
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
  status?: 'running' | 'completed' | 'error';
  error?: string;
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

type GeneratedPlugin = {
  id: string;
  name: string;
  description: string;
  version: string;
  directory: string;
  entryPath: string;
  manifestPath: string;
  createdAt: string;
  status: string;
  tools: GeneratedPluginTool[];
};

type GeneratedPluginTool = {
  name: string;
  description: string;
  parameters: unknown;
};

type GeneratedPluginList = {
  folder: string;
  plugins: GeneratedPlugin[];
};

type GeneratedPluginDetail = {
  plugin: GeneratedPlugin;
  manifestJson: unknown;
  manifestText: string;
  code: string;
  readme: string;
};

type PluginToolResult = {
  text?: string;
  references?: unknown[];
};

type ParsedToolCall = {
  toolName: string;
  args: Record<string, unknown>;
};

type ExploreLoopHandlers = {
  onStreamId: (streamId: string) => void;
  onDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onToolCall?: (toolCall: ParsedToolCall, step: number, content: string) => void;
  onToolResult?: (toolCall: ParsedToolCall, step: number, result: PluginToolResult) => void;
  onToolError?: (toolCall: ParsedToolCall, step: number, error: unknown) => void;
};

type AppMode = 'explore' | 'build';
type PluginConflictStrategy = 'error' | 'replace' | 'rename';
type SidebarView = 'chats' | 'plugins';

type ChatMeta = Pick<ChatHistoryPayload, 'chatId' | 'name' | 'createdAt' | 'updatedAt'>;

const INLINE_MARKDOWN_PATTERN =
  /(?:`([^`]+)`)|(?:\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(?:\*\*([^*]+)\*\*)|(?:__([^_]+)__)|(?:\*([^*]+)\*)|(?:_([^_]+)_)/g;
const MAX_MARKDOWN_RENDER_LENGTH = 20000;
const MAX_MARKDOWN_RENDER_LINES = 500;
const MAX_MARKDOWN_TABLE_ROWS = 40;
const MAX_MARKDOWN_TABLE_COLUMNS = 8;
const TOOL_CALL_BLOCK_PATTERNS = [
  /```tool_call\s+([A-Za-z0-9_.-]+)(?::\d+)?\s+([\s\S]*?)```/m,
  /```functions\.([A-Za-z0-9_.-]+)(?::\d+)?\s*([\s\S]*?)```/m
];
const MAX_TOOL_LOOP_STEPS = 6;

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
      <button id="pluginsToggle" class="sidebar-rail-btn" type="button" aria-label="Generated plugins" aria-pressed="false">
        ${iconSvg('plug')}
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
      <nav id="pluginList" class="chat-history-list is-hidden" aria-label="Generated plugins"></nav>
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
            <div class="mode-toggle" role="group" aria-label="Agent mode">
              <button type="button" data-mode-option="explore" aria-pressed="true">Explore</button>
              <button type="button" data-mode-option="build" aria-pressed="false">Build</button>
            </div>
          </div>
        </form>
      </section>

      <section id="messages" class="messages" aria-live="polite"></section>
      <section id="pluginDetailView" class="plugin-detail-view is-hidden" aria-live="polite"></section>

      <form id="chatForm" class="composer" autocomplete="off">
        <textarea id="chatInput" rows="1"></textarea>
        <div class="composer-meta-row">
          <span id="chatEnvLabel" class="composer-model-label">hello-world runtime</span>
          <div class="composer-controls">
            <div class="mode-toggle" role="group" aria-label="Agent mode">
              <button type="button" data-mode-option="explore" aria-pressed="true">Explore</button>
              <button type="button" data-mode-option="build" aria-pressed="false">Build</button>
            </div>
            <button id="stopStreamButton" class="stop-stream-button is-hidden" type="button" aria-label="Stop response">Stop</button>
          </div>
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
const pluginsToggle = document.querySelector<HTMLButtonElement>('#pluginsToggle');
const newChatRail = document.querySelector<HTMLButtonElement>('#newChatRail');
const chatSidebar = document.querySelector<HTMLElement>('#chatSidebar');
const sidebarClose = document.querySelector<HTMLButtonElement>('#sidebarClose');
const newChatButton = document.querySelector<HTMLButtonElement>('#newChatButton');
const chatHistoryList = document.querySelector<HTMLElement>('#chatHistoryList');
const pluginList = document.querySelector<HTMLElement>('#pluginList');
const chatHistoryStatus = document.querySelector<HTMLElement>('#chatHistoryStatus');
const introForm = document.querySelector<HTMLFormElement>('#introForm');
const introInput = document.querySelector<HTMLTextAreaElement>('#introInput');
const introEnvLabel = document.querySelector<HTMLElement>('#introEnvLabel');
const messages = document.querySelector<HTMLElement>('#messages');
const pluginDetailView = document.querySelector<HTMLElement>('#pluginDetailView');
const chatForm = document.querySelector<HTMLFormElement>('#chatForm');
const chatInput = document.querySelector<HTMLTextAreaElement>('#chatInput');
const chatEnvLabel = document.querySelector<HTMLElement>('#chatEnvLabel');
const stopStreamButton = document.querySelector<HTMLButtonElement>('#stopStreamButton');
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mode-option]'));
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
let generatedPlugins: GeneratedPlugin[] = [];
let selectedPluginId = '';
let sidebarView: SidebarView = 'chats';
let isRunning = false;
let activeStreamId = '';
let appMode: AppMode = loadAppMode();
let modelProviders: ModelProvider[] = [];

window.setTimeout(() => {
  shell?.classList.remove('is-booting');
  introInput?.focus();
}, 650);

loadEnvStatus().catch(() => {
  setEnvLabel('no .env loaded');
});
void refreshChatHistory();
void refreshGeneratedPlugins();
syncModeControls();

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
  if (sidebarView !== 'chats') {
    setSidebarView('chats');
    return;
  }
  setSidebarOpen(!shell?.classList.contains('sidebar-open'));
});
pluginsToggle?.addEventListener('click', () => {
  if (sidebarView !== 'plugins') {
    setSidebarView('plugins');
    void refreshGeneratedPlugins();
    return;
  }
  setSidebarOpen(!shell?.classList.contains('sidebar-open'));
});

sidebarClose?.addEventListener('click', () => setSidebarOpen(false));
newChatButton?.addEventListener('click', () => {
  setSidebarView('chats');
  void startNewConversation({ showPreChat: true });
});
newChatRail?.addEventListener('click', () => {
  setSidebarView('chats');
  void startNewConversation({ showPreChat: true });
});
for (const button of modeButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.modeOption === 'build' ? 'build' : 'explore';
    setAppMode(mode);
  });
}
stopStreamButton?.addEventListener('click', () => {
  const streamId = activeStreamId;
  if (!streamId) return;
  stopStreamButton.disabled = true;
  stopStreamButton.textContent = 'Stopping';
  void cancelAgentTurnStream(streamId);
});

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
    plug: '<path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a6 6 0 0 1-12 0V8z"></path>',
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
  const modeSuffix = appMode === 'build' ? 'builder' : 'explorer';
  if (introEnvLabel) introEnvLabel.textContent = `${label} · ${modeSuffix}`;
  if (chatEnvLabel) chatEnvLabel.textContent = `${label} · ${modeSuffix}`;
}

function loadAppMode(): AppMode {
  try {
    return localStorage.getItem('raynard-app-mode') === 'build' ? 'build' : 'explore';
  } catch {
    return 'explore';
  }
}

function setAppMode(mode: AppMode) {
  appMode = mode;
  try {
    localStorage.setItem('raynard-app-mode', mode);
  } catch {}
  syncModeControls();
  void loadEnvStatus().catch(() => {
    setEnvLabel('no .env loaded');
  });
}

function syncModeControls() {
  for (const button of modeButtons) {
    const selected = button.dataset.modeOption === appMode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  if (shell) {
    shell.dataset.mode = appMode;
  }
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
  const activeToggle = sidebarView === 'plugins' ? pluginsToggle : chatsToggle;
  activeToggle?.setAttribute('aria-pressed', String(open));
}

function setSidebarView(view: SidebarView) {
  sidebarView = view;
  setSidebarOpen(true);
  chatsToggle?.classList.toggle('is-active', view === 'chats');
  pluginsToggle?.classList.toggle('is-active', view === 'plugins');
  chatsToggle?.setAttribute('aria-pressed', String(view === 'chats'));
  pluginsToggle?.setAttribute('aria-pressed', String(view === 'plugins'));
  if (chatHistoryList) chatHistoryList.classList.toggle('is-hidden', view !== 'chats');
  if (pluginList) pluginList.classList.toggle('is-hidden', view !== 'plugins');
  const title = chatSidebar?.querySelector('h2');
  if (title) title.textContent = view === 'plugins' ? 'Generated Plugins' : 'Chats';
  newChatButton?.classList.toggle('is-hidden', view !== 'chats');
  if (chatHistoryStatus) {
    chatHistoryStatus.textContent =
      view === 'plugins'
        ? generatedPlugins.length
          ? ''
          : 'No generated plugins yet.'
        : chatHistoryRows.length
          ? ''
          : 'No saved chats yet.';
  }
}

async function refreshGeneratedPlugins() {
  try {
    const result = await invoke<GeneratedPluginList>('list_generated_plugins');
    generatedPlugins = result.plugins;
    renderGeneratedPlugins();
    if (sidebarView === 'plugins' && chatHistoryStatus) {
      chatHistoryStatus.textContent = generatedPlugins.length ? '' : 'No generated plugins yet.';
    }
  } catch (error) {
    if (sidebarView === 'plugins' && chatHistoryStatus) {
      chatHistoryStatus.textContent = getErrorMessage(error, 'Could not load plugins.');
    }
  }
}

function renderGeneratedPlugins() {
  if (!pluginList) return;
  pluginList.innerHTML = '';

  if (!generatedPlugins.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-list-empty';
    empty.textContent = 'No generated plugins yet.';
    pluginList.appendChild(empty);
    return;
  }

  for (const plugin of generatedPlugins) {
    const row = document.createElement('div');
    row.className = `chat-history-row${plugin.id === selectedPluginId ? ' is-active' : ''}`;

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'chat-history-open';
    openButton.innerHTML = `
      <span class="chat-history-title">${escapeHtml(plugin.name)}</span>
      <span class="chat-history-meta">${escapeHtml(plugin.status || 'plugin')} · ${plugin.tools.length} tools</span>
    `;
    openButton.addEventListener('click', () => void openGeneratedPlugin(plugin.id));
    row.appendChild(openButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'chat-history-delete';
    deleteButton.setAttribute('aria-label', `Delete ${plugin.name}`);
    deleteButton.innerHTML = iconSvg('trash-2');
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void deleteGeneratedPlugin(plugin.id);
    });
    row.appendChild(deleteButton);

    pluginList.appendChild(row);
  }
}

async function openGeneratedPlugin(pluginId: string) {
  if (!pluginDetailView || !messages) return;
  const detail = await invoke<GeneratedPluginDetail>('read_generated_plugin', { pluginId });
  selectedPluginId = detail.plugin.id;
  renderGeneratedPlugins();
  renderPluginDetail(detail);
  shell?.classList.add('plugin-view');
  shell?.classList.remove('pre-chat');
  pluginDetailView.classList.remove('is-hidden');
  messages.classList.add('is-hidden');
  chatForm?.classList.add('is-hidden');
  document.querySelector<HTMLElement>('.intro-stage')?.classList.add('is-hidden');
}

async function deleteGeneratedPlugin(pluginId: string) {
  const plugin = generatedPlugins.find((item) => item.id === pluginId);
  const label = plugin?.name || pluginId;
  if (!window.confirm(`Delete generated plugin "${label}"? This removes its files from the generated plugins folder.`)) {
    return;
  }

  await invoke('delete_generated_plugin', { pluginId });
  if (selectedPluginId === pluginId) {
    selectedPluginId = '';
    pluginDetailView?.classList.add('is-hidden');
    messages?.classList.remove('is-hidden');
    chatForm?.classList.remove('is-hidden');
    shell?.classList.remove('plugin-view');
  }
  await refreshGeneratedPlugins();
}

function renderPluginDetail(detail: GeneratedPluginDetail) {
  if (!pluginDetailView) return;
  const { plugin } = detail;
  pluginDetailView.innerHTML = '';

  const header = document.createElement('header');
  header.className = 'plugin-detail-header';
  header.innerHTML = `
    <div class="plugin-detail-title">
      <span class="plugin-detail-kicker">Generated Plugin</span>
      <h1>${escapeHtml(plugin.name)}</h1>
      <p>${escapeHtml(plugin.description || 'No description provided.')}</p>
    </div>
    <button class="plugin-detail-delete" type="button">
      ${iconSvg('trash-2')}
      <span>Delete</span>
    </button>
  `;
  header.querySelector<HTMLButtonElement>('.plugin-detail-delete')?.addEventListener('click', () => {
    void deleteGeneratedPlugin(plugin.id);
  });
  pluginDetailView.appendChild(header);

  const meta = document.createElement('dl');
  meta.className = 'plugin-detail-meta';
  appendPluginResultRow(meta, 'ID', plugin.id);
  appendPluginResultRow(meta, 'Version', plugin.version || 'n/a');
  appendPluginResultRow(meta, 'Status', plugin.status || 'n/a');
  appendPluginResultRow(meta, 'Created', plugin.createdAt || 'n/a');
  appendPluginResultRow(meta, 'Directory', plugin.directory);
  appendPluginResultRow(meta, 'Manifest', plugin.manifestPath);
  appendPluginResultRow(meta, 'Entrypoint', plugin.entryPath);
  pluginDetailView.appendChild(meta);

  const tools = document.createElement('section');
  tools.className = 'plugin-detail-section';
  tools.innerHTML = '<h2>Tools</h2>';
  if (plugin.tools.length) {
    const list = document.createElement('div');
    list.className = 'plugin-tool-list';
    for (const tool of plugin.tools) {
      const item = document.createElement('div');
      item.className = 'plugin-tool-row';
      item.innerHTML = `
        <code>${escapeHtml(tool.name)}</code>
        <span>
          ${escapeHtml(tool.description || 'No description provided.')}
          <small>${escapeHtml(stringifyPromptJson(tool.parameters || { type: 'object', properties: {} }))}</small>
        </span>
      `;
      list.appendChild(item);
    }
    tools.appendChild(list);
  } else {
    const empty = document.createElement('p');
    empty.className = 'plugin-detail-empty';
    empty.textContent = 'This plugin manifest does not declare any tools.';
    tools.appendChild(empty);
  }
  pluginDetailView.appendChild(tools);

  if (detail.readme.trim()) {
    const readme = document.createElement('section');
    readme.className = 'plugin-detail-section plugin-readme';
    readme.innerHTML = '<h2>README</h2>';
    const readmeBody = document.createElement('div');
    readmeBody.className = 'message-text';
    renderMessageText(readmeBody, detail.readme, true);
    readme.appendChild(readmeBody);
    pluginDetailView.appendChild(readme);
  }

  pluginDetailView.appendChild(createPluginCodeSection('plugin.json', detail.manifestText));
  pluginDetailView.appendChild(createPluginCodeSection('index.ts', detail.code || '// No index.ts found.'));
}

function createPluginCodeSection(title: string, codeText: string) {
  const section = document.createElement('section');
  section.className = 'plugin-detail-section plugin-code-section';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = codeText || '';
  pre.appendChild(code);
  section.appendChild(heading);
  section.appendChild(pre);
  return section;
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

function persistActiveChatHistoryQuietly() {
  void persistActiveChatHistory().catch((error) => {
    void logAgentTurnEvent('persist_error', {
      message: getErrorMessage(error)
    });
  });
}

function createTurnSnapshotPersister(intervalMs = 450) {
  let lastPersistedAt = 0;
  let timer: number | undefined;

  const flush = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    lastPersistedAt = Date.now();
    persistActiveChatHistoryQuietly();
  };

  return {
    schedule(force = false) {
      if (force) {
        flush();
        return;
      }
      const elapsed = Date.now() - lastPersistedAt;
      if (elapsed >= intervalMs) {
        flush();
        return;
      }
      if (!timer) {
        timer = window.setTimeout(flush, Math.max(50, intervalMs - elapsed));
      }
    },
    flush
  };
}

function logAgentTurnEvent(eventType: string, payload: Record<string, unknown>) {
  const chatId = activeSessionId;
  if (!chatId) return Promise.resolve();
  return invoke('append_agent_turn_log', {
    event: {
      chatId,
      eventType,
      timestamp: Date.now(),
      payload
    }
  }).catch(() => undefined);
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
    shell?.classList.remove('plugin-view');
    pluginDetailView?.classList.add('is-hidden');
    messages?.classList.remove('is-hidden');
    chatForm?.classList.remove('is-hidden');
  }
  await refreshChatHistory();
}

async function startNewConversation(options: { showPreChat: boolean }) {
  if (isRunning) return;
  await persistActiveChatHistory();
  resetConversationState();
  messages?.replaceChildren();
  shell?.classList.remove('plugin-view');
  selectedPluginId = '';
  renderGeneratedPlugins();
  pluginDetailView?.classList.add('is-hidden');
  messages?.classList.remove('is-hidden');
  chatForm?.classList.remove('is-hidden');
  document.querySelector<HTMLElement>('.intro-stage')?.classList.remove('is-hidden');
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

  const capabilityRequest = detectCapabilityRequest(content);
  if (capabilityRequest.requested) {
    if (appMode === 'explore') {
      renderExploreModeCapabilityNotice(capabilityRequest);
      return;
    }
    renderCapabilityConfirmation(capabilityRequest);
    return;
  }

  const pending = addMessage('assistant', '', true);
  const pendingBody = pending.querySelector<HTMLElement>('.message-text');
  const thinkingPreview = document.createElement('div');
  thinkingPreview.className = 'thinking-preview';
  thinkingPreview.textContent = 'Thinking...';
  pending.prepend(thinkingPreview);
  let streamed = '';
  let thinking = '';
  const assistantRecord: StoredChatMessage = {
    role: 'assistant',
    text: 'Thinking...',
    timestamp: Date.now(),
    status: 'running'
  };
  storedMessages.push(assistantRecord);
  const snapshotPersister = createTurnSnapshotPersister();
  isRunning = true;
  setStopButtonVisible(true);
  await persistActiveChatHistory();
  void logAgentTurnEvent('turn_start', {
    mode: appMode,
    userMessage: content
  });

  try {
    const reply = await runExploreAgentLoop(chatMessages, {
      onStreamId: (streamId) => {
        activeStreamId = streamId;
        void logAgentTurnEvent('stream_id', { streamId });
      },
      onDelta: (delta) => {
        streamed += delta;
        assistantRecord.text = streamed || 'Thinking...';
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        snapshotPersister.schedule();
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
        assistantRecord.text = streamed || 'Thinking...';
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        snapshotPersister.schedule();
        void logAgentTurnEvent('thinking_delta', {
          delta,
          thinkingTail: thinking.slice(-4000)
        });
        thinkingPreview.textContent = formatThinkingPreview(thinking);
        messages.scrollTop = messages.scrollHeight;
      },
      onToolCall: (toolCall, step, toolContent) => {
        assistantRecord.text = streamed || toolContent || 'Running tool...';
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        snapshotPersister.schedule(true);
        void logAgentTurnEvent('tool_call', {
          step,
          toolName: toolCall.toolName,
          args: toolCall.args,
          assistantContent: toolContent
        });
      },
      onToolResult: (toolCall, step, result) => {
        assistantRecord.text = streamed || `Ran ${toolCall.toolName}.`;
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        snapshotPersister.schedule(true);
        void logAgentTurnEvent('tool_result', {
          step,
          toolName: toolCall.toolName,
          args: toolCall.args,
          result
        });
      },
      onToolError: (toolCall, step, error) => {
        assistantRecord.text = getErrorMessage(error, `Tool failed: ${toolCall.toolName}`);
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'error';
        assistantRecord.error = assistantRecord.text;
        snapshotPersister.schedule(true);
        void logAgentTurnEvent('tool_error', {
          step,
          toolName: toolCall.toolName,
          args: toolCall.args,
          error: getErrorMessage(error)
        });
      }
    });
    if (thinkingPreview.parentElement) {
      thinkingPreview.remove();
    }
    let finalContent = reply.content || streamed || 'The model returned an empty response.';
    if (pendingBody) {
      renderMessageText(pendingBody, finalContent, true);
    }
    pending.classList.remove('pending');
    chatMessages.push({ role: 'assistant', content: finalContent });
    assistantRecord.text = finalContent;
    assistantRecord.timestamp = Date.now();
    assistantRecord.thinking = thinking.trim() || undefined;
    assistantRecord.provider = reply.provider;
    assistantRecord.model = reply.model;
    assistantRecord.status = 'completed';
    assistantRecord.error = undefined;
    await persistActiveChatHistory();
    void logAgentTurnEvent('turn_completed', {
      provider: reply.provider,
      model: reply.model,
      text: finalContent,
      thinking
    });
    await refreshChatHistory();
    if (reply.provider && reply.model) {
      setEnvLabel(`${reply.provider}/${reply.model}`);
    }
  } catch (error) {
    pending.remove();
    const errorMessage = getErrorMessage(error);
    addMessage('assistant', errorMessage);
    assistantRecord.text = errorMessage;
    assistantRecord.timestamp = Date.now();
    assistantRecord.thinking = thinking.trim() || undefined;
    assistantRecord.status = 'error';
    assistantRecord.error = errorMessage;
    await persistActiveChatHistory();
    void logAgentTurnEvent('turn_error', {
      error: errorMessage,
      streamed,
      thinking
    });
    await refreshChatHistory();
  } finally {
    snapshotPersister.flush();
    isRunning = false;
    activeStreamId = '';
    setStopButtonVisible(false);
    chatInput?.focus();
  }
}

async function runExploreAgentLoop(
  baseMessages: ChatMessage[],
  handlers: ExploreLoopHandlers
) {
  const scratchMessages = await buildExploreMessagesForModel(baseMessages);
  let reply = await runAgentTurnStream(scratchMessages, handlers);
  let content = reply.content || '';
  let provider = reply.provider;
  let model = reply.model;

  if (appMode !== 'explore') {
    return reply;
  }

  for (let step = 0; step < MAX_TOOL_LOOP_STEPS; step += 1) {
    const toolCall = parseToolCallBlock(content);
    if (!toolCall) break;

    handlers.onToolCall?.(toolCall, step, content);
    handlers.onThinkingDelta(`\nRunning ${toolCall.toolName}...\n`);
    let toolResult: PluginToolResult;
    try {
      toolResult = await executeGeneratedToolCall(toolCall);
    } catch (error) {
      handlers.onToolError?.(toolCall, step, error);
      throw error;
    }
    handlers.onToolResult?.(toolCall, step, toolResult);
    const toolResultMessage = formatToolResultForModel(toolCall, toolResult);

    scratchMessages.push(
      {
        role: 'assistant',
        content
      },
      {
        role: 'user',
        content: toolResultMessage
      }
    );

    reply = await runAgentTurnStream(scratchMessages, handlers);
    content = reply.content || '';
    provider = reply.provider ?? provider;
    model = reply.model ?? model;
  }

  if (parseToolCallBlock(content)) {
    return {
      content:
        'I reached the tool-call limit before composing a final answer. Try narrowing the request or asking for fewer items.',
      provider,
      model
    };
  }

  return {
    content,
    provider,
    model
  };
}

function setStopButtonVisible(visible: boolean) {
  if (!stopStreamButton) return;
  stopStreamButton.classList.toggle('is-hidden', !visible);
  stopStreamButton.disabled = !visible;
  stopStreamButton.textContent = 'Stop';
}

function parseToolCallBlock(content: string): ParsedToolCall | null {
  const match = TOOL_CALL_BLOCK_PATTERNS.map((pattern) => pattern.exec(content)).find(Boolean);
  if (!match) return null;
  const toolName = normalizeToolName(match[1]?.trim() || '');
  const rawArgs = match[2]?.trim() || '{}';
  if (!toolName) return null;
  try {
    const args = JSON.parse(rawArgs);
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { toolName, args: {} };
    }
    return { toolName, args };
  } catch {
    return null;
  }
}

function normalizeToolName(toolName: string) {
  return toolName.replace(/^functions\./, '').trim();
}

async function executeGeneratedToolCall(toolCall: ParsedToolCall) {
  const result = await invoke<PluginToolResult>('execute_generated_plugin_tool', {
    request: {
      toolName: toolCall.toolName,
      args: toolCall.args
    }
  });
  return result;
}

function formatToolResultForModel(toolCall: ParsedToolCall, result: PluginToolResult) {
  const references = Array.isArray(result.references) ? result.references : [];
  const payload = {
    toolName: toolCall.toolName,
    args: toolCall.args,
    text: result.text || '',
    references
  };

  return [
    `Tool result for ${toolCall.toolName}:`,
    'Use this result to answer the user. If the result contains references, inspect their referenceMeta and expandedContent payloads for facts you need.',
    'If the user request still requires more data, output exactly one more fenced tool_call block. Otherwise provide the final answer with concrete details.',
    '```json',
    JSON.stringify(payload, null, 2),
    '```'
  ].join('\n');
}

async function buildExploreMessagesForModel(messagesForConversation: ChatMessage[]) {
  if (appMode !== 'explore') return messagesForConversation;

  try {
    const result = await invoke<GeneratedPluginList>('list_generated_plugins');
    generatedPlugins = result.plugins;
    renderGeneratedPlugins();
  } catch {
    return messagesForConversation;
  }

  const toolLines = generatedPlugins.flatMap((plugin) =>
    plugin.tools.map((tool) => {
      const description = tool.description || plugin.description || 'No description provided.';
      return [
        `Tool: ${tool.name}`,
        `Plugin: ${plugin.name} (${plugin.id})`,
        `Description: ${description}`,
        `Arguments JSON schema: ${stringifyPromptJson(tool.parameters || { type: 'object', properties: {} })}`
      ].join('\n');
    })
  );

  if (!toolLines.length) return messagesForConversation;

  const toolCatalog = [
    'Raynard Explore mode context:',
    'Generated API tools are available. Before answering API/data questions, choose the relevant tool from this catalog.',
    'Be thorough: if a result only identifies IDs or a user profile and the user asked for story details, keep using tools until you have enough data to answer.',
    'When a tool is needed, output exactly one fenced block and no extra prose:',
    '```tool_call toolName',
    '{"argument":"value"}',
    '```',
    'Do not invent tools. Do not ask to build code in Explore mode.',
    '<available_generated_tools>',
    ...toolLines.map((line) => `${line}\n---`),
    '</available_generated_tools>'
  ].join('\n');

  return [{ role: 'user' as const, content: toolCatalog }, ...messagesForConversation];
}

function stringifyPromptJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function renderExploreModeCapabilityNotice(request: CapabilityRequest) {
  const article = addMessage('assistant', '');
  const body = article.querySelector<HTMLElement>('.message-text');
  const text =
    `Explorer mode cannot build or modify plugins. Switch to Build mode to create "${request.name}", or stay in Explorer mode to query installed API capabilities.`;

  if (body) {
    body.innerHTML = '';
    const panel = document.createElement('section');
    panel.className = 'capability-confirmation';

    const title = document.createElement('h3');
    title.textContent = 'Build request blocked in Explorer mode';
    panel.appendChild(title);

    const description = document.createElement('p');
    description.textContent =
      'Explorer mode never invokes the Pi coding-agent or writes plugin code.';
    panel.appendChild(description);

    const summary = document.createElement('p');
    summary.className = 'capability-request-summary';
    summary.textContent = request.description;
    panel.appendChild(summary);

    const actions = document.createElement('div');
    actions.className = 'capability-actions';

    const switchMode = document.createElement('button');
    switchMode.type = 'button';
    switchMode.className = 'capability-primary-action';
    switchMode.textContent = 'Switch to Build mode';
    switchMode.addEventListener('click', () => {
      setAppMode('build');
      article.remove();
      renderCapabilityConfirmation(request);
      switchMode.disabled = true;
    });
    actions.appendChild(switchMode);

    panel.appendChild(actions);
    body.appendChild(panel);
  }

  chatMessages.push({ role: 'assistant', content: text });
  storedMessages.push({
    role: 'assistant',
    text,
    timestamp: Date.now()
  });
  void persistActiveChatHistory();
  void refreshChatHistory();
}

function renderCapabilityConfirmation(request: CapabilityRequest) {
  const article = addMessage('assistant', '');
  const body = article.querySelector<HTMLElement>('.message-text');
  if (!body) return;

  body.innerHTML = '';
  const panel = document.createElement('section');
  panel.className = 'capability-confirmation';

  const title = document.createElement('h3');
  title.textContent = `Create plugin: ${request.name}`;
  panel.appendChild(title);

  const description = document.createElement('p');
  description.textContent =
    'This requires writing code. Raynard will create a plugin workspace first; the Pi coding-agent sidecar can fill in the API tool code in the next step.';
  panel.appendChild(description);

  const summary = document.createElement('p');
  summary.className = 'capability-request-summary';
  summary.textContent = request.description;
  panel.appendChild(summary);

  const actions = document.createElement('div');
  actions.className = 'capability-actions';

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'capability-primary-action';
  confirm.textContent = 'Create plugin workspace';
  actions.appendChild(confirm);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'capability-secondary-action';
  cancel.textContent = 'Cancel';
  actions.appendChild(cancel);

  panel.appendChild(actions);
  body.appendChild(panel);

  const persistAssistantStatus = async (text: string) => {
    chatMessages.push({ role: 'assistant', content: text });
    storedMessages.push({
      role: 'assistant',
      text,
      timestamp: Date.now()
    });
    await persistActiveChatHistory();
    await refreshChatHistory();
  };

  cancel.addEventListener('click', () => {
    confirm.disabled = true;
    cancel.disabled = true;
    const text = 'Canceled plugin creation. No code was written.';
    body.textContent = text;
    void persistAssistantStatus(text);
  });

  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    cancel.disabled = true;
    void scaffoldAndRunPluginBuilder(request, body, persistAssistantStatus, {
      conflictStrategy: 'error'
    });
  });
}

async function scaffoldAndRunPluginBuilder(
  request: CapabilityRequest,
  body: HTMLElement,
  persistAssistantStatus: (text: string) => Promise<void>,
  options: { conflictStrategy: PluginConflictStrategy; name?: string }
) {
  let streamed = '';
  let thinking = '';
  isRunning = true;
  setStopButtonVisible(true);

  try {
    body.querySelector('.capability-confirmation p')?.replaceChildren('Creating plugin workspace...');
    const plugin = await invoke<GeneratedPlugin>('scaffold_plugin_capability', {
      request: {
        name: options.name || request.name,
        description: request.description,
        sourceUrls: request.sourceUrls,
        conflictStrategy: options.conflictStrategy
      }
    });
    renderPluginScaffoldResult(body, plugin);
    const builderOutput = document.createElement('div');
    builderOutput.className = 'builder-output';
    builderOutput.textContent = 'Starting plugin builder...';
    body.appendChild(builderOutput);

    const reply = await runPluginBuilderStream(
      {
        pluginDir: plugin.directory,
        name: plugin.name,
        description: plugin.description,
        sourceUrls: request.sourceUrls,
        prompt: request.description
      },
      {
        onStreamId: (streamId) => {
          activeStreamId = streamId;
        },
        onDelta: (delta) => {
          streamed += delta;
          builderOutput.textContent = streamed;
          messages?.scrollTo({ top: messages.scrollHeight });
        },
        onThinkingDelta: (delta) => {
          thinking += delta;
          if (!streamed.trim()) {
            builderOutput.textContent = formatThinkingPreview(thinking);
          }
          messages?.scrollTo({ top: messages.scrollHeight });
        }
      }
    );
    const finalContent = reply.content || streamed || 'Plugin builder completed.';
    builderOutput.textContent = finalContent;
    await persistAssistantStatus(finalContent);
  } catch (error) {
    const errorMessage = getErrorMessage(error, 'Could not create plugin workspace.');
    if (/Generated plugin already exists:/i.test(errorMessage)) {
      renderPluginConflictResolution(body, request, persistAssistantStatus);
      return;
    }
    body.textContent = errorMessage;
    await persistAssistantStatus(errorMessage);
  } finally {
    isRunning = false;
    activeStreamId = '';
    setStopButtonVisible(false);
    chatInput?.focus();
  }
}

function renderPluginConflictResolution(
  body: HTMLElement,
  request: CapabilityRequest,
  persistAssistantStatus: (text: string) => Promise<void>
) {
  body.innerHTML = '';
  const panel = document.createElement('section');
  panel.className = 'capability-confirmation';

  const title = document.createElement('h3');
  title.textContent = `Plugin already exists: ${request.name}`;
  panel.appendChild(title);

  const description = document.createElement('p');
  description.textContent = 'Choose how to continue this Build-mode request.';
  panel.appendChild(description);

  const input = document.createElement('input');
  input.className = 'plugin-name-input';
  input.type = 'text';
  input.value = `${request.name}-2`;
  input.placeholder = 'New plugin name';
  input.spellcheck = false;
  panel.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'capability-actions';

  const overwrite = document.createElement('button');
  overwrite.type = 'button';
  overwrite.className = 'capability-primary-action';
  overwrite.textContent = 'Overwrite existing';
  actions.appendChild(overwrite);

  const useName = document.createElement('button');
  useName.type = 'button';
  useName.className = 'capability-secondary-action';
  useName.textContent = 'Use this name';
  actions.appendChild(useName);

  const autoName = document.createElement('button');
  autoName.type = 'button';
  autoName.className = 'capability-secondary-action';
  autoName.textContent = 'Auto-name copy';
  actions.appendChild(autoName);

  panel.appendChild(actions);
  body.appendChild(panel);

  const disableActions = () => {
    overwrite.disabled = true;
    useName.disabled = true;
    autoName.disabled = true;
    input.disabled = true;
  };

  overwrite.addEventListener('click', () => {
    disableActions();
    void scaffoldAndRunPluginBuilder(request, body, persistAssistantStatus, {
      conflictStrategy: 'replace'
    });
  });

  useName.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) {
      description.textContent = 'Enter a plugin name before continuing.';
      input.focus();
      return;
    }
    disableActions();
    void scaffoldAndRunPluginBuilder(request, body, persistAssistantStatus, {
      conflictStrategy: 'error',
      name
    });
  });

  autoName.addEventListener('click', () => {
    disableActions();
    void scaffoldAndRunPluginBuilder(request, body, persistAssistantStatus, {
      conflictStrategy: 'rename'
    });
  });

  input.focus();
  input.select();
}

function renderPluginScaffoldResult(container: HTMLElement, plugin: GeneratedPlugin) {
  container.innerHTML = '';
  const panel = document.createElement('section');
  panel.className = 'capability-confirmation is-complete';

  const title = document.createElement('h3');
  title.textContent = `Plugin workspace created`;
  panel.appendChild(title);

  const list = document.createElement('dl');
  list.className = 'plugin-result-list';
  appendPluginResultRow(list, 'Name', plugin.name);
  appendPluginResultRow(list, 'ID', plugin.id);
  appendPluginResultRow(list, 'Status', plugin.status);
  appendPluginResultRow(list, 'Directory', plugin.directory);
  appendPluginResultRow(list, 'Manifest', plugin.manifestPath);
  appendPluginResultRow(list, 'Entrypoint', plugin.entryPath);
  panel.appendChild(list);

  container.appendChild(panel);
}

function appendPluginResultRow(list: HTMLElement, label: string, value: string) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value || 'n/a';
  list.appendChild(term);
  list.appendChild(description);
}

function formatThinkingPreview(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Thinking...';
  return `Thinking: ${normalized.slice(-220)}`;
}

function showConversation() {
  shell?.classList.remove('pre-chat');
  shell?.classList.remove('plugin-view');
  selectedPluginId = '';
  renderGeneratedPlugins();
  pluginDetailView?.classList.add('is-hidden');
  messages?.classList.remove('is-hidden');
  chatForm?.classList.remove('is-hidden');
  document.querySelector<HTMLElement>('.intro-stage')?.classList.remove('is-hidden');
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
