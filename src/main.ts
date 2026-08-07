import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errors';
import {
  cancelAgentTurnStream,
  runMainAgentStream,
  runPluginBuilderStream,
  type AgentBuildRequest,
  type ChatMessage,
  type PluginBuilderRequest
} from './agent-runtime';
import {
  automaticModeForUserTurn,
  confirmedPluginWriteMode,
  modeSwitchStatus,
  pluginWriteConfirmationCopy
} from './build-request-flow';
import {
  applyBuilderToolEvent,
  planBuilderTimeline,
  type BuilderToolActivity,
  type BuilderToolEvent
} from './builder-activity';
import { decideChatNavigation } from './navigation-state';
import { ChatRunRegistry, type ChatRun } from './chat-run-registry';
import { renderResultCards } from './result-card/mount';
import { buildExampleData } from './result-card/example';
import type { CardTemplate, StoredResultCard } from './result-card/types';
import {
  buildMentionItems,
  filterMentionItems,
  getReferenceQueryAtCursor,
  type MentionItem
} from './mention';
import foxLogoMarkup from './assets/northfox-fox-logo.svg?raw';
import './styles.css';

type CapabilityRequest = AgentBuildRequest;

type LlmEnvStatus = {
  found: boolean;
  path: string | null;
  keys: string[];
  provider: string;
  model: string;
  codingProvider: string;
  codingModel: string;
  configured: boolean;
  codingConfigured: boolean;
};

type ModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  defaultChatModel: string;
  defaultCodingModel: string;
  chatModel: string;
  codingModel: string;
  chatActive: boolean;
  codingActive: boolean;
  connected: boolean;
};

type ModelRole = 'chat' | 'coding';

type ModelProviderList = {
  providers: ModelProvider[];
};

type StoredChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  modeStatus?: boolean;
  thinking?: string;
  provider?: string;
  model?: string;
  status?: 'running' | 'completed' | 'error';
  error?: string;
  builderRun?: boolean;
  builderActivities?: BuilderToolActivity[];
  cards?: StoredResultCard[];
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
  activeBuildPlugin?: ActiveBuildPlugin;
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
  card?: CardTemplate;
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

type AppMode = 'explore' | 'build';
type PluginConflictStrategy = 'error' | 'replace' | 'rename' | 'edit';
type PluginScaffoldStatus = {
  normalizedName: string;
  exists: boolean;
  nextAvailableName: string;
};
type SidebarView = 'chats' | 'plugins';

// The plugin a Build-mode chat is actively editing. Once set, later Build-mode
// messages route straight to the coding agent for this plugin.
type ActiveBuildPlugin = { dir: string; name: string };

type ChatMeta = Pick<ChatHistoryPayload, 'chatId' | 'name' | 'createdAt' | 'updatedAt'> & {
  activeBuildPlugin?: ActiveBuildPlugin;
};

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
  <main class="app-shell pre-chat is-booting" aria-label="Raynard">
    <section class="boot-overlay" role="status" aria-live="polite" aria-label="Starting Raynard">
      <div class="boot-overlay-inner">
        <div class="brand-mark" aria-hidden="true">${foxLogoMarkup}</div>
        <p class="boot-overlay-brand">raynard</p>
        <div class="boot-overlay-spinner" aria-hidden="true"></div>
      </div>
    </section>

    <aside id="sidebarRail" class="sidebar-rail" aria-label="Sidebar">
      <button id="chatsToggle" class="sidebar-rail-btn is-active" type="button" aria-label="Toggle chats sidebar" aria-pressed="false">
        ${iconSvg('message-square')}
      </button>
      <button id="pluginsToggle" class="sidebar-rail-btn" type="button" aria-label="Generated plugins" aria-pressed="false">
        ${iconSvg('plug')}
      </button>
      <button id="newChatRail" class="sidebar-rail-btn" type="button" aria-label="New chat">
        ${iconSvg('plus')}
      </button>
    </aside>

    <aside id="chatSidebar" class="chat-sidebar" aria-label="Chats">
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
          <div class="brand-mark">${foxLogoMarkup}</div>
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

      <div id="mentionMenu" class="mention-menu is-hidden" aria-hidden="true"></div>

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

      <section id="extensionDeleteModal" class="extension-delete-modal-overlay is-hidden" aria-hidden="true">
        <div class="extension-delete-modal" role="dialog" aria-modal="true" aria-labelledby="extensionDeleteTitle">
          <header class="extension-delete-header">
            <h2 id="extensionDeleteTitle">Delete Extension</h2>
            <p id="extensionDeleteText">This removes the generated extension files.</p>
          </header>
          <div class="extension-delete-actions">
            <button id="extensionDeleteCancel" class="extension-delete-secondary" type="button">Cancel</button>
            <button id="extensionDeleteConfirm" class="extension-delete-primary" type="button">Delete</button>
          </div>
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
const mentionMenu = document.querySelector<HTMLElement>('#mentionMenu');
type MentionState = {
  input: HTMLTextAreaElement;
  items: MentionItem[];
  active: number;
  range: { replaceStart: number; replaceEnd: number };
};
let mentionState: MentionState | null = null;
const modelsModal = document.querySelector<HTMLElement>('#modelsModal');
const modelsModalTitle = document.querySelector<HTMLElement>('#modelsModalTitle');
const modelsModalHint = document.querySelector<HTMLElement>('#modelsModalHint');
const modelsModalContent = document.querySelector<HTMLElement>('#modelsModalContent');
const modelsModalClose = document.querySelector<HTMLButtonElement>('#modelsModalClose');
const extensionDeleteModal = document.querySelector<HTMLElement>('#extensionDeleteModal');
const extensionDeleteText = document.querySelector<HTMLElement>('#extensionDeleteText');
const extensionDeleteCancel = document.querySelector<HTMLButtonElement>('#extensionDeleteCancel');
const extensionDeleteConfirm = document.querySelector<HTMLButtonElement>('#extensionDeleteConfirm');

let activeSessionId = createSessionId();
let activeChatMeta = createChatMeta(activeSessionId);
let chatMessages: ChatMessage[] = [];
let storedMessages: StoredChatMessage[] = [];
let chatHistoryRows: ChatHistoryRow[] = [];
let generatedPlugins: GeneratedPlugin[] = [];
let selectedPluginId = '';
let sidebarView: SidebarView = 'chats';
const chatRuns = new ChatRunRegistry<ChatMeta, StoredChatMessage>();
const renderedMessageArticles = new WeakMap<StoredChatMessage, HTMLElement>();
let appMode: AppMode = loadAppMode();
let modelProviders: ModelProvider[] = [];
let llmEnvStatus: LlmEnvStatus | null = null;
let mainViewRevision = 0;
let pendingExtensionDelete:
  | {
      resolve: (confirmed: boolean) => void;
    }
  | null = null;

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
    syncMentionMenu(input);
  });

  // Re-evaluate the @menu when the caret moves (arrow keys, clicks).
  input?.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) syncMentionMenu(input);
  });
  input?.addEventListener('click', () => syncMentionMenu(input));
  input?.addEventListener('blur', () => {
    window.setTimeout(hideMentionMenu, 120);
  });

  input?.addEventListener('keydown', (event) => {
    // The open @menu owns arrow/enter/tab/escape before anything else.
    if (handleMentionKeydown(event)) return;

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
extensionDeleteCancel?.addEventListener('click', () => resolveExtensionDelete(false));
extensionDeleteConfirm?.addEventListener('click', () => resolveExtensionDelete(true));
extensionDeleteModal?.addEventListener('click', (event) => {
  if (event.target === extensionDeleteModal) {
    resolveExtensionDelete(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pendingExtensionDelete) {
    resolveExtensionDelete(false);
  }
});

chatsToggle?.addEventListener('click', () => {
  if (sidebarView !== 'chats') {
    setSidebarView('chats');
    if (shell?.classList.contains('plugin-view')) {
      showConversation();
    }
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
  button.disabled = true;
  button.title = 'Mode switches automatically';
}
stopStreamButton?.addEventListener('click', () => {
  const streamId = chatRuns.get(activeSessionId)?.streamId;
  if (!streamId) return;
  stopStreamButton.disabled = true;
  stopStreamButton.textContent = 'Stopping';
  void cancelAgentTurnStream(streamId);
});

async function loadEnvStatus() {
  const status = await invoke<LlmEnvStatus>('load_llm_env_status');
  llmEnvStatus = status;
  renderComposerModelLabel();
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

function renderComposerModelLabel() {
  if (!llmEnvStatus) {
    setEnvLabel('no .env loaded');
    return;
  }

  const isBuild = appMode === 'build';
  const provider = isBuild ? llmEnvStatus.codingProvider : llmEnvStatus.provider;
  const model = isBuild ? llmEnvStatus.codingModel : llmEnvStatus.model;
  const configured = isBuild ? llmEnvStatus.codingConfigured : llmEnvStatus.configured;

  if (!llmEnvStatus.found) {
    setEnvLabel(`no .env loaded - ${provider}/${model}`);
    return;
  }

  setEnvLabel(configured ? `${provider}/${model}` : `.env found - missing ${provider} key`);
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
  renderComposerModelLabel();
  void loadEnvStatus().catch(() => {
    setEnvLabel('no .env loaded');
  });
}

async function switchAppModeWithStatus(mode: AppMode) {
  const status = modeSwitchStatus(appMode, mode);
  setAppMode(mode);
  if (!status) return;

  const article = addMessage('assistant', status);
  article.classList.add('mode-status-message');
  storedMessages.push({
    role: 'assistant',
    text: status,
    timestamp: Date.now(),
    modeStatus: true
  });
  await persistActiveChatHistory();
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

function mentionMenuIsOpen(): boolean {
  return Boolean(mentionMenu && !mentionMenu.classList.contains('is-hidden'));
}

function hideMentionMenu() {
  mentionMenu?.classList.add('is-hidden');
  mentionMenu?.setAttribute('aria-hidden', 'true');
  mentionState = null;
}

// Show the "@" reference menu when the cursor is inside an @token, listing the
// installed plugins / tools / cards filtered by what's typed so far.
function syncMentionMenu(input: HTMLTextAreaElement | null) {
  if (!input || !mentionMenu) return;
  const ref = getReferenceQueryAtCursor(input.value, input.selectionStart ?? input.value.length);
  if (!ref) {
    hideMentionMenu();
    return;
  }
  const items = filterMentionItems(buildMentionItems(generatedPlugins), ref.query);
  if (!items.length) {
    hideMentionMenu();
    return;
  }
  mentionState = { input, items, active: 0, range: { replaceStart: ref.replaceStart, replaceEnd: ref.replaceEnd } };
  renderMentionMenu();
  const rect = input.getBoundingClientRect();
  mentionMenu.style.left = `${Math.round(rect.left)}px`;
  mentionMenu.style.width = `${Math.round(rect.width)}px`;
  mentionMenu.classList.remove('is-hidden');
  mentionMenu.setAttribute('aria-hidden', 'false');
  // Anchor above the input now that its height is known.
  const menuRect = mentionMenu.getBoundingClientRect();
  mentionMenu.style.top = `${Math.max(8, Math.round(rect.top - menuRect.height - 8))}px`;
}

function renderMentionMenu() {
  if (!mentionMenu || !mentionState) return;
  mentionMenu.innerHTML = '';
  mentionState.items.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mention-item${index === mentionState!.active ? ' is-active' : ''}`;
    const kind = document.createElement('span');
    kind.className = `mention-kind mention-kind-${item.kind}`;
    kind.textContent = item.kind;
    const label = document.createElement('span');
    label.className = 'mention-label';
    label.textContent = item.label;
    const desc = document.createElement('span');
    desc.className = 'mention-desc';
    desc.textContent = item.description;
    button.append(kind, label, desc);
    // mousedown fires before the textarea blur, so clicking selects cleanly.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applyMention(item);
    });
    mentionMenu.appendChild(button);
  });
}

function applyMention(item: MentionItem) {
  if (!mentionState) return;
  const { input, range } = mentionState;
  const before = input.value.slice(0, range.replaceStart);
  const after = input.value.slice(range.replaceEnd);
  const insert = `${item.insertText} `;
  input.value = `${before}${insert}${after}`;
  const cursor = before.length + insert.length;
  hideMentionMenu();
  input.focus();
  input.setSelectionRange(cursor, cursor);
}

// Returns true when the keystroke was consumed by the open mention menu.
function handleMentionKeydown(event: KeyboardEvent): boolean {
  if (!mentionMenuIsOpen() || !mentionState) return false;
  const count = mentionState.items.length;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    mentionState.active = (mentionState.active + 1) % count;
    renderMentionMenu();
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    mentionState.active = (mentionState.active - 1 + count) % count;
    renderMentionMenu();
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    applyMention(mentionState.items[mentionState.active]);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    hideMentionMenu();
    return true;
  }
  return false;
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
  if (modelsModalHint) modelsModalHint.textContent = 'Select separate models for chat/explore and coding/build.';
  modelsModalContent.innerHTML = '';

  for (const provider of modelProviders) {
    const row = document.createElement('section');
    row.className = `models-provider-row${provider.chatActive || provider.codingActive ? ' is-active' : ''}`;
    row.innerHTML = `
      <span class="models-provider-icon" aria-hidden="true">${providerIcon(provider.id)}</span>
      <span class="models-provider-main">
        <strong>${escapeHtml(provider.name)}</strong>
        <span>${escapeHtml(provider.baseUrl.replace(/^https?:\/\//, ''))}</span>
      </span>
      <div class="models-provider-controls">
        <label class="models-role-field">
          <span>Chat</span>
          <input class="models-role-input" data-role="chat" value="${escapeHtml(provider.chatModel || provider.defaultChatModel)}" spellcheck="false" />
        </label>
        <button type="button" class="models-role-action${provider.chatActive ? ' is-active' : ''}" data-role="chat">
          ${provider.connected ? (provider.chatActive ? 'Chat active' : 'Use for chat') : 'Add key'}
        </button>
        <label class="models-role-field">
          <span>Coding</span>
          <input class="models-role-input" data-role="coding" value="${escapeHtml(provider.codingModel || provider.defaultCodingModel)}" spellcheck="false" />
        </label>
        <button type="button" class="models-role-action${provider.codingActive ? ' is-active' : ''}" data-role="coding">
          ${provider.connected ? (provider.codingActive ? 'Coding active' : 'Use for coding') : 'Add key'}
        </button>
      </div>
    `;
    row.querySelectorAll<HTMLButtonElement>('.models-role-action').forEach((button) => {
      button.addEventListener('click', () => {
        const role = button.dataset.role === 'coding' ? 'coding' : 'chat';
        const input = row.querySelector<HTMLInputElement>(`.models-role-input[data-role="${role}"]`);
        const model =
          input?.value.trim() ||
          (role === 'coding' ? provider.defaultCodingModel : provider.defaultChatModel);
        void selectProvider(provider, role, model);
      });
    });
    modelsModalContent.appendChild(row);
  }
}

async function selectProvider(provider: ModelProvider, role: ModelRole, model: string) {
  if (!provider.connected) {
    renderApiKeyStep(provider, role, model);
    return;
  }

  try {
    const result = await invoke<ModelProviderList>('set_active_model_provider', {
      providerId: provider.id,
      role,
      model
    });
    modelProviders = result.providers;
    setEnvLabel(labelFromProvidersForMode(modelProviders) || `${provider.id}/${model}`);
    closeModelsModal();
  } catch (error) {
    if (modelsModalHint) modelsModalHint.textContent = getErrorMessage(error, `Could not select ${provider.name}.`);
  }
}

function renderApiKeyStep(provider: ModelProvider, role: ModelRole, model: string) {
  if (!modelsModalContent) return;
  if (modelsModalTitle) modelsModalTitle.textContent = provider.name;
  if (modelsModalHint) modelsModalHint.textContent = `Paste your API key to use ${model} for ${role}.`;
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
        apiKey,
        role,
        model
      });
      input.value = '';
      modelProviders = result.providers;
      setEnvLabel(labelFromProvidersForMode(modelProviders) || `${provider.id}/${model}`);
      closeModelsModal();
    } catch (error) {
      if (modelsModalHint) modelsModalHint.textContent = getErrorMessage(error, `Could not save ${provider.name} key.`);
    }
  });

  modelsModalContent.appendChild(form);
  setTimeout(() => input.focus(), 0);
}

function labelFromProvidersForMode(providers: ModelProvider[]) {
  const active = providers.find((provider) => (appMode === 'build' ? provider.codingActive : provider.chatActive));
  if (!active) return '';
  return appMode === 'build' ? `${active.id}/${active.codingModel}` : `${active.id}/${active.chatModel}`;
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
  const viewRevision = ++mainViewRevision;
  const detail = await invoke<GeneratedPluginDetail>('read_generated_plugin', { pluginId });
  if (viewRevision !== mainViewRevision) return;
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
  const confirmed = await confirmExtensionDelete(label);
  if (!confirmed) {
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

function confirmExtensionDelete(label: string) {
  if (!extensionDeleteModal || !extensionDeleteText || !extensionDeleteConfirm) {
    return Promise.resolve(
      window.confirm(`Delete extension "${label}"? This removes its generated files.`)
    );
  }

  if (pendingExtensionDelete) {
    pendingExtensionDelete.resolve(false);
  }

  extensionDeleteText.textContent = `Delete "${label}"? This removes the generated extension files and cannot be undone.`;
  extensionDeleteConfirm.disabled = false;
  extensionDeleteModal.classList.remove('is-hidden');
  extensionDeleteModal.setAttribute('aria-hidden', 'false');
  extensionDeleteConfirm.focus();

  return new Promise<boolean>((resolve) => {
    pendingExtensionDelete = { resolve };
  });
}

function resolveExtensionDelete(confirmed: boolean) {
  if (!pendingExtensionDelete) return;
  const pending = pendingExtensionDelete;
  pendingExtensionDelete = null;
  if (extensionDeleteConfirm) extensionDeleteConfirm.disabled = true;
  extensionDeleteModal?.classList.add('is-hidden');
  extensionDeleteModal?.setAttribute('aria-hidden', 'true');
  pending.resolve(confirmed);
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

  renderPluginCardPreviews(plugin);

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

// Preview the result cards a plugin's tools render, using synthesized example
// data (no API call). Only tools that declare a `card` appear.
function renderPluginCardPreviews(plugin: GeneratedPlugin) {
  if (!pluginDetailView) return;
  const cardTools = plugin.tools.filter(
    (tool) => tool.card && typeof tool.card === 'object' && Array.isArray(tool.card.layout)
  );

  const section = document.createElement('section');
  section.className = 'plugin-detail-section';
  section.innerHTML = '<h2>Result cards</h2>';

  if (!cardTools.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-detail-empty';
    empty.textContent =
      'No result cards yet. In Build mode, ask to add cards to this plugin’s detail tools.';
    section.appendChild(empty);
    pluginDetailView.appendChild(section);
    return;
  }

  const hint = document.createElement('p');
  hint.className = 'plugin-detail-hint';
  hint.textContent = 'How these tools render their results, shown with example data.';
  section.appendChild(hint);

  for (const tool of cardTools) {
    const template = tool.card as CardTemplate;
    const block = document.createElement('div');
    block.className = 'plugin-card-preview';
    const label = document.createElement('code');
    label.className = 'plugin-card-preview-tool';
    label.textContent = tool.name;
    block.appendChild(label);
    const mount = document.createElement('div');
    block.appendChild(mount);
    renderResultCards(
      mount,
      [{ toolName: tool.name, template, data: buildExampleData(template) }],
      { collapsible: false }
    );
    section.appendChild(block);
  }
  pluginDetailView.appendChild(section);
}

function stringifyPromptJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
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
    const running = chatRuns.get(chat.chatId);
    openButton.innerHTML = `
      <span class="chat-history-title">${escapeHtml(chat.name)}</span>
      <span class="chat-history-meta">${formatChatDate(chat.updatedAt)} · ${chat.messageCount} messages${running ? ` · ${running.kind === 'builder' ? 'Building' : 'Thinking'}` : ''}</span>
    `;
    openButton.addEventListener('click', () => void openSavedChat(chat.chatId));
    row.appendChild(openButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'chat-history-delete';
    deleteButton.setAttribute('aria-label', `Delete ${chat.name}`);
    deleteButton.disabled = Boolean(running);
    if (running) deleteButton.title = 'Stop this chat before deleting it';
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

// Persist a specific chat's snapshot (meta + messages) regardless of which chat
// is currently on screen. A running turn captures its own meta/messages so that
// navigating to another chat mid-run cannot redirect the save to the wrong chat.
async function persistChatSnapshot(meta: ChatMeta | undefined, stored: StoredChatMessage[]) {
  if (!meta || !stored.length) return;
  meta.updatedAt = new Date().toISOString();
  await invoke<ChatHistoryRow>('save_chat_history', {
    payload: { ...meta, messages: stored }
  });
}

function persistChatSnapshotQuietly(meta: ChatMeta | undefined, stored: StoredChatMessage[]) {
  void persistChatSnapshot(meta, stored).catch((error) => {
    void logAgentTurnEvent('persist_error', { message: getErrorMessage(error) }, meta?.chatId);
  });
}

// True when the user is scrolled to (or near) the bottom of the transcript, so
// we only auto-follow new content when they haven't scrolled up to read.
function isNearBottom(el: HTMLElement | null, threshold = 140): boolean {
  if (!el) return false;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function scrollMessagesToBottom() {
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function createTurnSnapshotPersister(persist: () => void, intervalMs = 450) {
  let lastPersistedAt = 0;
  let timer: number | undefined;

  const flush = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    lastPersistedAt = Date.now();
    persist();
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

function logAgentTurnEvent(
  eventType: string,
  payload: Record<string, unknown>,
  chatId = activeSessionId
) {
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
  if (!messages) return;
  const decision = decideChatNavigation({
    targetChatId: chatId,
    activeChatId: activeSessionId,
    isRunning: chatRuns.has(activeSessionId)
  });
  if (decision === 'show-active') {
    showConversation();
    renderChatHistory();
    chatInput?.focus();
    return;
  }
  if (decision === 'block') return;

  const viewRevision = ++mainViewRevision;
  await persistActiveChatHistory();
  if (viewRevision !== mainViewRevision) return;

  const liveRun = chatRuns.get(chatId);
  if (liveRun) {
    bindChatState(liveRun.meta, liveRun.messages);
    renderStoredTranscript();
    showConversation();
    renderChatHistory();
    syncRunControls();
    chatInput?.focus();
    return;
  }

  const chat = await invoke<ChatHistoryPayload>('read_chat_history', { chatId });
  if (viewRevision !== mainViewRevision) return;
  bindChatState({
    chatId: chat.chatId,
    name: chat.name,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    activeBuildPlugin: chat.activeBuildPlugin
  }, chat.messages);
  renderStoredTranscript();

  showConversation();
  renderChatHistory();
  syncRunControls();
  chatInput?.focus();
}

function bindChatState(meta: ChatMeta, nextStoredMessages: StoredChatMessage[]) {
  activeSessionId = meta.chatId;
  activeChatMeta = meta;
  storedMessages = nextStoredMessages;
  chatMessages = storedMessages
    .filter((message) => !message.modeStatus)
    .map((message) => ({
      role: message.role,
      content: message.text
    }));
}

function renderStoredTranscript() {
  if (!messages) return;
  chatMessages = storedMessages
    .filter((message) => !message.modeStatus)
    .map((message) => ({ role: message.role, content: message.text }));
  messages.innerHTML = '';
  for (const message of storedMessages) {
    renderStoredMessage(message);
  }
}

async function deleteSavedChat(chatId: string) {
  if (chatRuns.has(chatId)) return;
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
  mainViewRevision += 1;
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
  syncRunControls();
  await refreshChatHistory();
}

function resetConversationState() {
  activeSessionId = createSessionId();
  activeChatMeta = createChatMeta(activeSessionId);
  chatMessages = [];
  storedMessages = [];
}

function renderStoredMessage(message: StoredChatMessage) {
  const article = addMessage(message.role, message.builderRun ? '' : message.text, false, message.role === 'assistant');
  renderedMessageArticles.set(message, article);
  if (message.modeStatus) article.classList.add('mode-status-message');
  if (message.role === 'assistant' && message.builderRun) {
    const body = article.querySelector<HTMLElement>('.message-text');
    if (body) {
      const live = message.status === 'running' && chatRuns.has(activeSessionId);
      renderBuilderRun(body, message, live);
    }
  }
  if (message.role === 'assistant' && message.cards?.length) {
    renderMessageCards(article, message.cards);
  }
}

/** Find or create the card container appended after a message's text body. */
function ensureCardContainer(article: HTMLElement): HTMLElement {
  let container = article.querySelector<HTMLElement>(':scope > .message-cards');
  if (!container) {
    container = document.createElement('div');
    container.className = 'message-cards';
    article.appendChild(container);
  }
  return container;
}

/** Mount (or re-mount) result cards beneath a message article. */
function renderMessageCards(article: HTMLElement, cards: StoredResultCard[] | undefined) {
  if (!cards || !cards.length) return;
  renderResultCards(ensureCardContainer(article), cards);
}

/** Pull a storable result card out of a tool-result event, if the tool has one. */
function extractResultCard(event: { toolName: string; result: unknown }): StoredResultCard | null {
  const result = event.result;
  if (!result || typeof result !== 'object') return null;
  const card = (result as Record<string, unknown>).card;
  if (!card || typeof card !== 'object' || !Array.isArray((card as Record<string, unknown>).layout)) {
    return null;
  }
  return {
    toolName: event.toolName,
    template: card as StoredResultCard['template'],
    data: (result as Record<string, unknown>).data ?? {}
  };
}

async function submitMessage(input: HTMLTextAreaElement | null) {
  if (!input || !messages || chatRuns.has(activeSessionId)) return;

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
  void persistActiveChatHistory();
  void refreshChatHistory();

  // Every ordinary user turn starts in Explore. Build is entered only from the
  // explicit plugin-writing confirmation below.
  void switchAppModeWithStatus(automaticModeForUserTurn());

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
  // Bind this turn to its chat so a background run (user navigated away) keeps
  // persisting to the right chat and stops mutating the on-screen transcript.
  const turnSessionId = activeSessionId;
  const turnMeta = activeChatMeta;
  const turnStored = storedMessages;
  const turnChatMessages = chatMessages;
  const turnMode = appMode;
  const run = chatRuns.begin(
    turnSessionId,
    'agent',
    turnMeta,
    turnStored,
    mainViewRevision
  );
  if (!run) return;
  const turnIsActive = () =>
    activeSessionId === turnSessionId && mainViewRevision === run.viewRevision;
  const syncRemountedTurn = () => syncRemountedRun(run, assistantRecord);
  const snapshotPersister = createTurnSnapshotPersister(() =>
    persistChatSnapshotQuietly(turnMeta, turnStored)
  );
  syncRunControls();
  renderChatHistory();
  await persistChatSnapshot(turnMeta, turnStored);
  void logAgentTurnEvent('turn_start', {
    mode: turnMode,
    userMessage: content
  }, turnSessionId);

  try {
    let requestedBuild: AgentBuildRequest | undefined;
    const reply = await runMainAgentStream(turnChatMessages, turnMode, {
      onStreamId: (streamId) => {
        chatRuns.setStreamId(turnSessionId, run.id, streamId);
        syncRunControls();
        void logAgentTurnEvent('stream_id', { streamId }, turnSessionId);
      },
      onDelta: (delta) => {
        streamed += delta;
        assistantRecord.text = streamed || 'Thinking...';
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        snapshotPersister.schedule();
        if (turnIsActive()) {
          const pinned = isNearBottom(messages);
          if (pendingBody) pendingBody.textContent = streamed;
          if (thinkingPreview.parentElement) thinkingPreview.remove();
          if (pinned) scrollMessagesToBottom();
        }
        syncRemountedTurn();
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
        }, turnSessionId);
        if (turnIsActive()) {
          const pinned = isNearBottom(messages);
          thinkingPreview.textContent = formatThinkingPreview(thinking);
          if (pinned) scrollMessagesToBottom();
        }
        syncRemountedTurn();
      },
      onToolCall: (toolCall) => {
        assistantRecord.text = streamed || `Running ${toolCall.toolName}...`;
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        snapshotPersister.schedule(true);
        syncRemountedTurn();
        void logAgentTurnEvent('tool_call', {
          toolName: toolCall.toolName,
          args: toolCall.args
        }, turnSessionId);
      },
      onToolResult: (toolCall) => {
        assistantRecord.text = streamed || `Ran ${toolCall.toolName}.`;
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        const resultCard = extractResultCard(toolCall);
        if (resultCard) {
          (assistantRecord.cards ??= []).push(resultCard);
          if (turnIsActive()) renderMessageCards(pending, assistantRecord.cards);
        }
        snapshotPersister.schedule(true);
        syncRemountedTurn();
        void logAgentTurnEvent('tool_result', {
          toolName: toolCall.toolName,
          args: toolCall.args,
          result: toolCall.result
        }, turnSessionId);
      },
      onToolError: (toolCall) => {
        assistantRecord.text = toolCall.error || `Tool failed: ${toolCall.toolName}`;
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'error';
        assistantRecord.error = assistantRecord.text;
        snapshotPersister.schedule(true);
        syncRemountedTurn();
        void logAgentTurnEvent('tool_error', {
          toolName: toolCall.toolName,
          args: toolCall.args,
          error: toolCall.error
        }, turnSessionId);
      },
      onBuildRequest: (request) => {
        requestedBuild = request;
        void logAgentTurnEvent('build_request', { request, mode: turnMode }, turnSessionId);
      }
    });
    if (thinkingPreview.parentElement) {
      thinkingPreview.remove();
    }
    requestedBuild = reply.buildRequest ?? requestedBuild;
    if (requestedBuild) {
      const recordIndex = turnStored.indexOf(assistantRecord);
      if (recordIndex >= 0) turnStored.splice(recordIndex, 1);
      if (turnIsActive()) {
        pending.remove();
        renderCapabilityConfirmation(requestedBuild);
      }
      syncRemountedTurn();
      return;
    }

    const finalContent = reply.content || streamed || 'The model returned an empty response.';
    if (turnIsActive()) {
      if (pendingBody) renderMessageText(pendingBody, finalContent, true);
      pending.classList.remove('pending');
      turnChatMessages.push({ role: 'assistant', content: finalContent });
    }
    assistantRecord.text = finalContent;
    assistantRecord.timestamp = Date.now();
    assistantRecord.thinking = thinking.trim() || undefined;
    assistantRecord.provider = reply.provider;
    assistantRecord.model = reply.model;
    assistantRecord.status = 'completed';
    assistantRecord.error = undefined;
    await persistChatSnapshot(turnMeta, turnStored);
    void logAgentTurnEvent('turn_completed', {
      provider: reply.provider,
      model: reply.model,
      text: finalContent,
      thinking
    }, turnSessionId);
    await refreshChatHistory();
    if (reply.provider && reply.model) {
      setEnvLabel(`${reply.provider}/${reply.model}`);
    }
    syncRemountedTurn();
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    if (turnIsActive()) {
      pending.remove();
      addMessage('assistant', errorMessage);
    }
    assistantRecord.text = errorMessage;
    assistantRecord.timestamp = Date.now();
    assistantRecord.thinking = thinking.trim() || undefined;
    assistantRecord.status = 'error';
    assistantRecord.error = errorMessage;
    await persistChatSnapshot(turnMeta, turnStored);
    void logAgentTurnEvent('turn_error', {
      error: errorMessage,
      streamed,
      thinking
    }, turnSessionId);
    await refreshChatHistory();
    syncRemountedTurn();
  } finally {
    snapshotPersister.flush();
    syncRemountedTurn();
    chatRuns.finish(turnSessionId, run.id);
    syncRunControls();
    renderChatHistory();
    if (activeSessionId === turnSessionId) chatInput?.focus();
  }
}

function syncRunControls() {
  const run = chatRuns.get(activeSessionId);
  const visible = Boolean(run);
  if (chatInput) chatInput.disabled = visible;
  if (!stopStreamButton) return;
  stopStreamButton.classList.toggle('is-hidden', !visible);
  stopStreamButton.disabled = !run?.streamId;
  stopStreamButton.textContent = run?.streamId ? 'Stop' : 'Starting';
}

function syncRemountedRun(
  run: ChatRun<ChatMeta, StoredChatMessage>,
  record?: StoredChatMessage
) {
  if (activeSessionId !== run.chatId || mainViewRevision === run.viewRevision) return;
  if (chatRuns.get(run.chatId)?.id !== run.id || storedMessages !== run.messages) return;
  const pinned = isNearBottom(messages);
  const article = record ? renderedMessageArticles.get(record) : undefined;
  if (article?.isConnected && record) {
    const body = article.querySelector<HTMLElement>('.message-text, .builder-run');
    if (body && record.builderRun) {
      renderBuilderRun(body, record, record.status === 'running');
    } else if (body) {
      renderMessageText(body, record.text, record.role === 'assistant');
      if (record.cards?.length) renderMessageCards(article, record.cards);
    }
  } else {
    renderStoredTranscript();
  }
  if (pinned) scrollMessagesToBottom();
}

function renderCapabilityConfirmation(request: CapabilityRequest) {
  const article = addMessage('assistant', '');
  const body = article.querySelector<HTMLElement>('.message-text');
  if (!body) return;
  const copy = pluginWriteConfirmationCopy(request.name);

  body.innerHTML = '';
  const panel = document.createElement('section');
  panel.className = 'capability-confirmation';

  const title = document.createElement('h3');
  title.textContent = copy.title;
  panel.appendChild(title);

  const description = document.createElement('p');
  description.textContent = copy.description;
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
  confirm.textContent = copy.confirmLabel;
  actions.appendChild(confirm);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'capability-secondary-action';
  cancel.textContent = 'Cancel';
  actions.appendChild(cancel);

  panel.appendChild(actions);
  body.appendChild(panel);

  const statusMeta = activeChatMeta;
  const statusStored = storedMessages;
  const statusChatMessages = chatMessages;
  const persistAssistantStatus = async (text: string) => {
    statusChatMessages.push({ role: 'assistant', content: text });
    statusStored.push({
      role: 'assistant',
      text,
      timestamp: Date.now()
    });
    await persistChatSnapshot(statusMeta, statusStored);
    await refreshChatHistory();
  };

  cancel.addEventListener('click', () => {
    confirm.disabled = true;
    cancel.disabled = true;
    const text = 'Canceled plugin write. No code was written.';
    body.textContent = text;
    void persistAssistantStatus(text);
  });

  confirm.addEventListener('click', () => {
    confirm.disabled = true;
    cancel.disabled = true;
    article.remove();
    // Start the chat-owned run synchronously before navigation can occur. The
    // status snapshot may persist in the background.
    void switchAppModeWithStatus(confirmedPluginWriteMode());
    const output = addMessage('assistant', '');
    const outputBody = output.querySelector<HTMLElement>('.message-text');
    if (!outputBody) return;
    void scaffoldAndRunPluginBuilder(request, outputBody, persistAssistantStatus, {
      conflictStrategy: 'error'
    });
  });
}

async function scaffoldAndRunPluginBuilder(
  request: CapabilityRequest,
  body: HTMLElement,
  persistAssistantStatus: (text: string) => Promise<void>,
  options: {
    conflictStrategy: PluginConflictStrategy;
    name?: string;
    editMode?: boolean;
    prompt?: string;
    messages?: ChatMessage[];
  }
) {
  let builderRecord: StoredChatMessage | undefined;
  let builderRun: HTMLElement | undefined;
  // Bind this run to the chat it started in. If the user navigates to another
  // chat mid-build, the run keeps persisting to its own chat and stops touching
  // the (now different) on-screen transcript.
  const turnSessionId = activeSessionId;
  const turnMeta = activeChatMeta;
  const turnStored = storedMessages;
  const run = chatRuns.begin(
    turnSessionId,
    'builder',
    turnMeta,
    turnStored,
    mainViewRevision
  );
  if (!run) {
    body.textContent = 'This chat already has an active run.';
    return;
  }
  const turnIsActive = () =>
    activeSessionId === turnSessionId && mainViewRevision === run.viewRevision;
  const syncRemountedTurn = () => syncRemountedRun(run, builderRecord);
  const snapshotPersister = createTurnSnapshotPersister(() =>
    persistChatSnapshotQuietly(turnMeta, turnStored)
  );
  syncRunControls();
  renderChatHistory();

  try {
    // Resolving to an existing plugin means the user wants to edit it — drop
    // into an in-place coding session instead of the create/overwrite conflict
    // flow. A new name falls through to a fresh scaffold below.
    if (options.conflictStrategy === 'error') {
      const status = await invoke<PluginScaffoldStatus>('get_plugin_scaffold_status', {
        name: options.name || request.name
      });
      if (status.exists) {
        options = {
          ...options,
          conflictStrategy: 'edit',
          editMode: true,
          name: status.normalizedName
        };
      }
    }
    body.textContent = pluginWriteConfirmationCopy(request.name).progress;
    const plugin = await invoke<GeneratedPlugin>('scaffold_plugin_capability', {
      request: {
        name: options.name || request.name,
        description: request.description,
        sourceUrls: request.sourceUrls,
        conflictStrategy: options.conflictStrategy
      }
    });
    const conflictingRun = chatRuns.values().find(
      (candidate) =>
        candidate.id !== run.id &&
        candidate.kind === 'builder' &&
        candidate.pluginDir === plugin.directory
    );
    if (conflictingRun) {
      throw new Error(
        `Another chat is already building "${plugin.name}". Wait for that run to finish before editing the same plugin.`
      );
    }
    // Claim this plugin for the duration of the run. Different plugins can
    // build concurrently; the same workspace cannot be edited safely twice.
    chatRuns.setPluginDir(turnSessionId, run.id, plugin.directory);
    turnMeta.activeBuildPlugin = { dir: plugin.directory, name: plugin.name };
    renderPluginScaffoldResult(body, plugin);
    builderRecord = {
      role: 'assistant',
      text: 'Plugin builder is running.',
      timestamp: Date.now(),
      status: 'running',
      builderRun: true,
      builderActivities: []
    };
    storedMessages.push(builderRecord);
    builderRun = document.createElement('div');
    body.appendChild(builderRun);
    renderBuilderRun(builderRun, builderRecord, true);
    await persistChatSnapshot(turnMeta, turnStored);

    await runPluginBuilderTurn(
      {
        pluginDir: plugin.directory,
        name: plugin.name,
        description: plugin.description,
        sourceUrls: request.sourceUrls,
        prompt: options.prompt || request.description,
        taskKind: request.taskKind,
        targetTools: request.targetTools,
        editMode: options.editMode ?? false,
        messages: options.messages
      },
      {
        builderRecord,
        builderRun,
        turnMeta,
        turnStored,
        turnIsActive,
        snapshotPersister,
        run,
        syncRemountedTurn
      }
    );
    await persistChatSnapshot(turnMeta, turnStored);
    syncRemountedTurn();
  } catch (error) {
    const errorMessage = getErrorMessage(error, 'Could not write plugin.');
    if (builderRecord && builderRun) {
      builderRecord.text = errorMessage;
      builderRecord.status = 'error';
      builderRecord.error = errorMessage;
      builderRecord.timestamp = Date.now();
      if (turnIsActive()) renderBuilderRun(builderRun, builderRecord, false);
      if (turnIsActive()) chatMessages.push({ role: 'assistant', content: errorMessage });
      await persistChatSnapshot(turnMeta, turnStored);
      await refreshChatHistory();
      syncRemountedTurn();
    } else {
      body.textContent = errorMessage;
      await persistAssistantStatus(errorMessage);
    }
  } finally {
    snapshotPersister.flush();
    syncRemountedTurn();
    chatRuns.finish(turnSessionId, run.id);
    syncRunControls();
    renderChatHistory();
    if (activeSessionId === turnSessionId) chatInput?.focus();
  }
}

type BuilderTurnContext = {
  builderRecord: StoredChatMessage;
  builderRun: HTMLElement;
  turnMeta: ChatMeta;
  turnStored: StoredChatMessage[];
  turnIsActive: () => boolean;
  snapshotPersister: ReturnType<typeof createTurnSnapshotPersister>;
  run: ChatRun<ChatMeta, StoredChatMessage>;
  syncRemountedTurn: () => void;
};

// One streaming coding-agent pass rendered into an existing builder-run message.
async function runPluginBuilderTurn(
  builderRequest: PluginBuilderRequest,
  ctx: BuilderTurnContext
): Promise<void> {
  const {
    builderRecord,
    builderRun,
    turnMeta,
    turnStored,
    turnIsActive,
    snapshotPersister,
    run,
    syncRemountedTurn
  } = ctx;
  let streamed = '';
  let thinking = '';
  const renderLive = () => {
    if (turnIsActive()) {
      renderBuilderRun(builderRun, builderRecord, true);
      scrollMessagesToBottom();
    } else {
      syncRemountedTurn();
    }
  };
  const applyToolEvent = (event: BuilderToolEvent) => {
    builderRecord.builderActivities = applyBuilderToolEvent(
      builderRecord.builderActivities || [],
      event
    );
    snapshotPersister.schedule();
    renderLive();
  };
  const reply = await runPluginBuilderStream(builderRequest, {
    onStreamId: (streamId) => {
      chatRuns.setStreamId(run.chatId, run.id, streamId);
      syncRunControls();
    },
    onDelta: (delta) => {
      streamed += delta;
      builderRecord.text = streamed;
      snapshotPersister.schedule();
      renderLive();
    },
    onThinkingDelta: (delta) => {
      thinking += delta;
      builderRecord.thinking = thinking;
      snapshotPersister.schedule();
      renderLive();
    },
    onToolExecutionStart: (event) => {
      applyToolEvent({ type: 'start', ...event });
      void logAgentTurnEvent('builder_tool_start', event, run.chatId);
    },
    onToolExecutionUpdate: (event) => {
      applyToolEvent({ type: 'update', ...event });
    },
    onToolExecutionEnd: (event) => {
      applyToolEvent({ type: 'end', ...event });
      void logAgentTurnEvent('builder_tool_end', event, run.chatId);
    }
  });
  const finalContent = reply.content || streamed || 'Done.';
  builderRecord.text = finalContent;
  builderRecord.thinking = thinking.trim() || undefined;
  builderRecord.provider = reply.provider;
  builderRecord.model = reply.model;
  builderRecord.status = 'completed';
  builderRecord.timestamp = Date.now();
  if (turnIsActive()) renderBuilderRun(builderRun, builderRecord, false);
  if (turnIsActive()) chatMessages.push({ role: 'assistant', content: finalContent });
  syncRemountedTurn();
  await persistChatSnapshot(turnMeta, turnStored);
  await refreshChatHistory();
}

function renderBuilderRun(
  container: HTMLElement,
  message: Pick<
    StoredChatMessage,
    'text' | 'thinking' | 'status' | 'error' | 'builderActivities'
  >,
  live: boolean
) {
  // Incremental reconcile — never tear down the subtree. Rebuilding on every
  // streaming event (238+ thinking deltas + every tool event) thrashed the main
  // thread, reset scroll, and wiped each card's expand state. Here we create
  // nodes once and patch only what changed, keyed by the stable tool call id.
  if (container.className !== 'builder-run') container.className = 'builder-run';

  // Thinking block.
  let thinking = container.querySelector<HTMLDetailsElement>(':scope > .builder-thinking');
  if (message.thinking) {
    if (!thinking) {
      thinking = document.createElement('details');
      thinking.className = 'builder-thinking';
      thinking.open = live && message.status === 'running';
      thinking.appendChild(document.createElement('summary'));
      const content = document.createElement('div');
      content.className = 'builder-thinking-content';
      thinking.appendChild(content);
      container.appendChild(thinking); // final position is enforced by the reorder below
    }
    const summary = thinking.querySelector('summary');
    const label = message.status === 'running' ? 'Builder reasoning' : 'Reasoning';
    if (summary && summary.textContent !== label) summary.textContent = label;
    const content = thinking.querySelector<HTMLElement>('.builder-thinking-content');
    if (content && content.textContent !== message.thinking) {
      content.textContent = message.thinking;
      // Follow the newest reasoning line inside its capped, scrollable box.
      if (live && message.status === 'running') content.scrollTop = content.scrollHeight;
    }
  } else if (thinking) {
    thinking.remove();
  }

  const activities = message.builderActivities || [];
  const summaryEl = () => container.querySelector(':scope > .builder-summary');
  let timeline = container.querySelector<HTMLElement>(':scope > .builder-timeline');
  let waiting = container.querySelector<HTMLElement>(':scope > .builder-waiting');

  if (activities.length) {
    if (waiting) waiting.remove();
    if (!timeline) {
      timeline = document.createElement('div');
      timeline.className = 'builder-timeline';
      container.insertBefore(timeline, summaryEl());
    }
    reconcileBuilderTimeline(timeline, activities);
  } else {
    if (timeline) timeline.remove();
    if (message.status === 'running') {
      if (!waiting) {
        waiting = document.createElement('div');
        waiting.className = 'builder-waiting';
        container.insertBefore(waiting, summaryEl());
      }
      waiting.textContent = 'Starting Pi coding agent…';
    } else if (waiting) {
      waiting.remove();
    }
  }

  // Liveness heartbeat — proves the run is alive while it waits on the model,
  // so a stalled streaming call no longer looks identical to a frozen UI.
  let heartbeat = container.querySelector<HTMLElement>(':scope > .builder-heartbeat');
  if (live && message.status === 'running') {
    if (!heartbeat) {
      heartbeat = document.createElement('div');
      heartbeat.className = 'builder-heartbeat';
      const dot = document.createElement('span');
      dot.className = 'builder-heartbeat-dot';
      heartbeat.appendChild(dot);
      heartbeat.appendChild(document.createElement('span'));
    }
    if (heartbeat.parentElement !== container) container.appendChild(heartbeat); // position set by reorder below
    const text = heartbeat.querySelector('span:last-child');
    const label = activities.length ? 'Working — waiting for the model…' : 'Working…';
    if (text && text.textContent !== label) text.textContent = label;
  } else if (heartbeat) {
    heartbeat.remove();
  }

  // Final summary text.
  const showSummary = Boolean(
    message.text && (message.text !== 'Plugin builder is running.' || message.status !== 'running')
  );
  let summary = container.querySelector<HTMLElement>(':scope > .builder-summary');
  if (showSummary) {
    if (!summary) {
      summary = document.createElement('div');
      summary.className = 'builder-summary message-text';
      container.appendChild(summary);
    }
    renderMessageText(summary, message.text || '', message.status !== 'running');
  } else if (summary) {
    summary.remove();
  }

  // Enforce top-level order: tool cards, then reasoning, then liveness, then the
  // final summary. Only move children that are out of place to avoid reflow.
  const ordered = [timeline, waiting, thinking, heartbeat, summary].filter(
    (el): el is HTMLElement => Boolean(el && el.parentElement === container)
  );
  ordered.forEach((el, index) => {
    if (container.children[index] !== el) {
      container.insertBefore(el, container.children[index] ?? null);
    }
  });
}

// Reconcile timeline cards against activities. applyBuilderToolEvent keeps
// activities append-only and updates entries in place, so card index i always
// maps to activity i: either patch the existing card or append a new one.
function reconcileBuilderTimeline(timeline: HTMLElement, activities: BuilderToolActivity[]) {
  const existingIds = Array.from(timeline.children).map(
    (child) => (child as HTMLElement).dataset.toolCallId || ''
  );
  const { ops, length } = planBuilderTimeline(existingIds, activities);
  for (const op of ops) {
    const activity = activities[op.index];
    if (op.action === 'reuse') {
      updateBuilderToolCard(timeline.children[op.index] as HTMLDetailsElement, activity);
    } else {
      const card = renderBuilderToolCard(activity);
      timeline.insertBefore(card, timeline.children[op.index] ?? null);
    }
  }
  while (timeline.children.length > length) {
    timeline.lastElementChild?.remove();
  }
}

function renderBuilderToolCard(activity: BuilderToolActivity) {
  const details = document.createElement('details');
  details.dataset.toolCallId = activity.toolCallId;

  const summary = document.createElement('summary');
  const identity = document.createElement('span');
  identity.className = 'builder-tool-identity';
  const name = document.createElement('strong');
  name.textContent = activity.toolName;
  identity.appendChild(name);
  const preview = document.createElement('span');
  preview.className = 'builder-tool-preview';
  identity.appendChild(preview);
  summary.appendChild(identity);
  const status = document.createElement('span');
  status.className = 'builder-tool-status';
  summary.appendChild(status);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'builder-tool-body';
  details.appendChild(body);

  updateBuilderToolCard(details, activity);
  return details;
}

function updateBuilderToolCard(details: HTMLDetailsElement, activity: BuilderToolActivity) {
  const cls = `builder-tool is-${activity.status}`;
  if (details.className !== cls) details.className = cls;

  // Auto-manage open/closed, but stop once the user has toggled it themselves.
  // We detect a user toggle by comparing the current open state to the value we
  // last set programmatically (recorded in data-auto-open).
  const shouldOpen =
    activity.status === 'pending' || activity.status === 'streaming' || activity.isError;
  const lastAuto = details.dataset.autoOpen;
  const userToggled = lastAuto !== undefined && details.open !== (lastAuto === '1');
  if (!userToggled) {
    if (details.open !== shouldOpen) details.open = shouldOpen;
    details.dataset.autoOpen = shouldOpen ? '1' : '0';
  }

  const name = details.querySelector('.builder-tool-identity strong');
  if (name && name.textContent !== activity.toolName) name.textContent = activity.toolName;
  const preview = details.querySelector('.builder-tool-preview');
  const previewText = formatBuilderToolArgsPreview(activity.args);
  if (preview && preview.textContent !== previewText) preview.textContent = previewText;
  const status = details.querySelector('.builder-tool-status');
  if (status && status.textContent !== activity.status) status.textContent = activity.status;

  const body = details.querySelector<HTMLElement>('.builder-tool-body');
  if (body) {
    setBuilderCodeBlock(body, 'args', 'Arguments', JSON.stringify(activity.args, null, 2));
    if (activity.output) {
      setBuilderCodeBlock(body, 'output', activity.isError ? 'Error' : 'Output', activity.output);
    } else {
      body.querySelector('[data-block="output"]')?.remove();
    }
  }
}

function formatBuilderToolArgsPreview(args: Record<string, unknown>) {
  for (const key of ['path', 'command', 'query', 'pattern']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ').slice(0, 90);
  }
  const keys = Object.keys(args);
  return keys.length ? keys.slice(0, 3).join(', ') : 'No arguments';
}

// Create-or-update a labelled code block identified by `key`, so streaming
// updates patch text in place instead of re-creating nodes.
function setBuilderCodeBlock(container: HTMLElement, key: string, label: string, value: string) {
  let block = container.querySelector<HTMLElement>(`[data-block="${key}"]`);
  if (!block) {
    block = document.createElement('div');
    block.dataset.block = key;
    const heading = document.createElement('div');
    heading.className = 'builder-tool-label';
    block.appendChild(heading);
    const pre = document.createElement('pre');
    pre.appendChild(document.createElement('code'));
    block.appendChild(pre);
    container.appendChild(block);
  }
  const heading = block.querySelector('.builder-tool-label');
  if (heading && heading.textContent !== label) heading.textContent = label;
  const code = block.querySelector('code');
  if (code && code.textContent !== value) code.textContent = value;
}

function renderPluginConflictResolution(
  body: HTMLElement,
  request: CapabilityRequest,
  persistAssistantStatus: (text: string) => Promise<void>,
  suggestedName = `${request.name}-2`
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
  input.value = suggestedName;
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
  title.textContent = `Plugin ready: ${plugin.name}`;
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
  mainViewRevision += 1;
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
