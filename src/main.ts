import { Channel, invoke } from '@tauri-apps/api/core';
import {
  createElement as createLucideElement,
  Database,
  Ellipsis,
  MessageSquare,
  PanelLeftClose,
  Plug,
  Plus,
  Trash2,
  type IconNode
} from 'lucide';
import { getErrorMessage } from './errors';
import { attachExternalLinkHandler } from './external-links';
import { agentActivityLabel } from './agent-activity';
import { parseChartSpec } from './chart-spec';
import { renderChart, unmountChart } from './chart-mount';
import { wrapCopyable } from './copy-affordance';
import { chartRootToPngBlob, chartSpecToMarkdown, tableToPngBlob } from './copy-export';
import { chartSourceEntries, extractToolSource, type ChartSource } from './chart-sources';
import {
  citedCitationNumbers,
  createChartCitationLine,
  createCitationLine,
  createInlineCitation
} from './citation-modal';
import { describeModelFailure } from './model-error';
import {
  cancelAgentTurnStream,
  runMainAgentStream,
  runPluginBuilderStream,
  type AgentBuildRequest,
  type AgentErrorEvent,
  type AgentRetryEvent,
  type ChatMessage,
  type PluginBuilderRequest,
  type TurnUsage
} from './agent-runtime';
import {
  automaticModeForUserTurn,
  confirmedPluginWriteMode,
  modeSwitchStatus,
  pluginWriteConfirmationCopy
} from './build-request-flow';
import {
  allCredentialsConfigured,
  credentialPromptCopy,
  missingCredentialKeys,
  retryPromptFor,
  type CredentialRequest
} from './credential-request-flow';
import {
  applyBuilderOutputDelta,
  applyBuilderStatusEvent,
  applyBuilderThinkingDelta,
  applyBuilderToolEvent,
  builderStatusLabel,
  collectBuilderReasoning,
  isOutputActivity,
  isReasoningActivity,
  isStatusActivity,
  planBuilderTimeline,
  type BuilderActivity,
  type BuilderOutputActivity,
  type BuilderReasoningActivity,
  type BuilderStatusActivity,
  type BuilderToolActivity,
  type BuilderToolEvent
} from './builder-activity';
import { decideChatNavigation } from './navigation-state';
import {
  needsProviderOnboarding,
  partitionProviders,
  providerActionLabel,
  providerCanSignOut,
  providerIsActive,
  providerNeedsAuth,
  type ProviderAuthMethod
} from './model-providers';
import { ChatRunRegistry, type ChatRun } from './chat-run-registry';
import { recoverInterruptedMessages, shouldUsePluginEditMode } from './plugin-build-state';
import { selectSplashPrompts } from './plugin-suggestions';
import { filterSlashCommands, type SlashCommand } from './slash-commands';
import {
  openStatusModal,
  type ChatUsageSnapshot,
  type ProviderQuota,
  type UsageTotals
} from './status-modal';
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
  authMethod: ProviderAuthMethod;
  /** Console page that issues keys for this provider; empty for sign-in. */
  apiKeyUrl: string;
};

/**
 * One surface that can run the connect-a-provider steps.
 *
 * Both the `/models` modal and the first-run splash walk the same three screens
 * (pick a provider, sign in, paste a key). They differ only in where the DOM
 * goes and what "back" and "done" mean, so the steps take this instead of
 * reaching for the modal's elements directly.
 */
type ProviderFlowHost = {
  content: HTMLElement;
  setTitle: (text: string) => void;
  setHint: (text: string) => void;
  onBack: () => void;
  onConnected: () => void;
};

type OAuthLoginEvent = {
  streamId: string;
  eventType: 'auth_url' | 'progress' | 'error';
  url?: string | null;
  message?: string | null;
  error?: string | null;
};

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
  /**
   * Set when the model provider — not a tool and not the app — ended the turn.
   * Persisted so a reloaded chat still says who failed instead of showing the
   * raw provider string as if it were an answer.
   */
  modelFailure?: { title: string; detail: string; raw: string };
  builderRun?: boolean;
  /** Tool calls and reasoning in the order they happened. */
  builderActivities?: BuilderActivity[];
  cards?: StoredResultCard[];
  /**
   * The API calls that fed this turn, one entry per citing tool call. Persisted
   * so a chart copied out of a reloaded chat still names its data sources.
   */
  sources?: ChartSource[];
  /**
   * A tool needed an API key the user has not stored. Persisted so the prompt
   * survives navigation and restart; it never carries a value, and whether each
   * key is configured is re-derived from the plugin list on every render.
   */
  credentialRequest?: StoredCredentialRequest;
  /**
   * Token counts for the turn that produced this message. Counts only — the
   * source of the context meter and the per-chat figures in `/status`.
   */
  usage?: TurnUsage;
};

type StoredCredentialRequest = {
  pluginId: string;
  pluginName: string;
  credentials: PluginCredentialRequirement[];
};

type PluginCredentialRequirement = {
  key: string;
  label: string;
  description?: string;
  signupUrl?: string;
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
  samplePrompts: string[];
  /** Declarations only. The host never sends credential values to the renderer. */
  credentials: PluginCredential[];
  tools: GeneratedPluginTool[];
};

type PluginCredential = {
  key: string;
  label: string;
  description: string;
  signupUrl: string;
  configured: boolean;
};

type GeneratedPluginTool = {
  name: string;
  description: string;
  parameters: unknown;
  card: CardTemplate;
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

type PluginCacheSettings = {
  enabled: boolean;
  ttlHours: number;
};

type AppMode = 'explore' | 'build';
type PluginConflictStrategy = 'error' | 'replace' | 'rename' | 'edit';
type PluginScaffoldStatus = {
  normalizedName: string;
  exists: boolean;
  nextAvailableName: string;
  hasRuntimeTools: boolean;
  status: string;
};
type SidebarView = 'chats' | 'plugins';

// The plugin a Build-mode chat is actively editing. Once set, later Build-mode
// messages route straight to the coding agent for this plugin.
type ActiveBuildPlugin = { dir: string; name: string };

type ChatMeta = Pick<ChatHistoryPayload, 'chatId' | 'name' | 'createdAt' | 'updatedAt'> & {
  activeBuildPlugin?: ActiveBuildPlugin;
};

/**
 * What a rendered assistant message knows about the turn behind it: the API
 * calls it cited, and the result cards those calls produced. A citation points
 * at a card by index, so the rows are stored once and read from here.
 */
type MessageContext = {
  sources: ChartSource[];
  cards: StoredResultCard[];
};

const EMPTY_MESSAGE_CONTEXT: MessageContext = { sources: [], cards: [] };

function messageContext(record: { sources?: ChartSource[]; cards?: StoredResultCard[] }): MessageContext {
  return { sources: record.sources ?? [], cards: record.cards ?? [] };
}

// The trailing alternative is a citation marker the model wrote, e.g. [^3].
const INLINE_MARKDOWN_PATTERN =
  /(?:`([^`]+)`)|(?:\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(?:\*\*([^*]+)\*\*)|(?:__([^_]+)__)|(?:\*([^*]+)\*)|(?:_([^_]+)_)|(?:\[\^(\d{1,3})\])/g;
const MAX_MARKDOWN_RENDER_LENGTH = 20000;
const MAX_MARKDOWN_RENDER_LINES = 500;
const MAX_MARKDOWN_TABLE_ROWS = 40;
const MAX_MARKDOWN_TABLE_COLUMNS = 8;
const DEFAULT_SPLASH_PROMPTS = [
  'Start a lightweight research conversation',
  'Summarize what this barebones app can do',
  'Say hello and show the conversation view'
] as const;
const appIcons: Record<string, IconNode> = {
  database: Database,
  ellipsis: Ellipsis,
  'message-square': MessageSquare,
  plus: Plus,
  'panel-left-close': PanelLeftClose,
  plug: Plug,
  'trash-2': Trash2
};

function iconSvg(name: string) {
  return createLucideElement(appIcons[name] ?? MessageSquare, {
    'aria-hidden': 'true'
  }).outerHTML;
}

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
            <span id="introEnvLabel" class="composer-model-label"></span>
          </div>
        </form>
      </section>

      <section id="messages" class="messages" aria-live="polite"></section>
      <section id="pluginDetailView" class="plugin-detail-view is-hidden" aria-live="polite"></section>

      <form id="chatForm" class="composer" autocomplete="off">
        <textarea id="chatInput" rows="1"></textarea>
        <div class="composer-meta-row">
          <span id="chatEnvLabel" class="composer-model-label"></span>
          <div class="composer-controls">
            <button id="stopStreamButton" class="stop-stream-button is-hidden" type="button" aria-label="Stop response">Stop</button>
          </div>
        </div>
      </form>

      <div id="slashMenu" class="slash-menu is-hidden" aria-hidden="true"></div>

      <div id="mentionMenu" class="mention-menu is-hidden" aria-hidden="true"></div>

      <section id="onboardingOverlay" class="onboarding-overlay is-hidden" aria-hidden="true">
        <div class="onboarding-panel" role="dialog" aria-modal="true" aria-labelledby="onboardingTitle">
          <div class="brand-mark" aria-hidden="true">${foxLogoMarkup}</div>
          <h1 id="onboardingTitle">Please select your AI frontier model</h1>
          <p id="onboardingHint">Sign in with ChatGPT and start straight away.</p>
          <div id="onboardingContent" class="onboarding-content"></div>
        </div>
      </section>

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

      <section id="pluginCacheModal" class="plugin-cache-modal-overlay is-hidden" aria-hidden="true">
        <div class="plugin-cache-modal" role="dialog" aria-modal="true" aria-labelledby="pluginCacheTitle">
          <header class="plugin-cache-header">
            <h2 id="pluginCacheTitle">Plugin Cache</h2>
            <p id="pluginCacheHint">Reuse recent API responses for this plugin.</p>
          </header>
          <label class="plugin-cache-toggle">
            <input id="pluginCacheEnabled" type="checkbox" checked>
            <span>Enable API response cache</span>
          </label>
          <label class="plugin-cache-duration">
            <span>Cache duration</span>
            <span class="plugin-cache-duration-input">
              <input id="pluginCacheTtl" type="number" min="1" max="8760" step="1" value="24" inputmode="numeric">
              <span>hours</span>
            </span>
          </label>
          <p id="pluginCacheStatus" class="plugin-cache-status" aria-live="polite"></p>
          <div class="plugin-cache-actions">
            <button id="pluginCacheClear" class="plugin-cache-clear" type="button">Clear cached results</button>
            <div>
              <button id="pluginCacheCancel" class="extension-delete-secondary" type="button">Cancel</button>
              <button id="pluginCacheSave" class="plugin-cache-save" type="button">Save</button>
            </div>
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
const suggestionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-suggestion]'));
const slashMenu = document.querySelector<HTMLElement>('#slashMenu');
type SlashState = { input: HTMLTextAreaElement; items: SlashCommand[]; active: number };
let slashState: SlashState | null = null;
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
const onboardingOverlay = document.querySelector<HTMLElement>('#onboardingOverlay');
const onboardingTitle = document.querySelector<HTMLElement>('#onboardingTitle');
const onboardingHint = document.querySelector<HTMLElement>('#onboardingHint');
const onboardingContent = document.querySelector<HTMLElement>('#onboardingContent');
const modelsModalClose = document.querySelector<HTMLButtonElement>('#modelsModalClose');
const extensionDeleteModal = document.querySelector<HTMLElement>('#extensionDeleteModal');
const extensionDeleteText = document.querySelector<HTMLElement>('#extensionDeleteText');
const extensionDeleteCancel = document.querySelector<HTMLButtonElement>('#extensionDeleteCancel');
const extensionDeleteConfirm = document.querySelector<HTMLButtonElement>('#extensionDeleteConfirm');
const pluginCacheModal = document.querySelector<HTMLElement>('#pluginCacheModal');
const pluginCacheTitle = document.querySelector<HTMLElement>('#pluginCacheTitle');
const pluginCacheHint = document.querySelector<HTMLElement>('#pluginCacheHint');
const pluginCacheEnabled = document.querySelector<HTMLInputElement>('#pluginCacheEnabled');
const pluginCacheTtl = document.querySelector<HTMLInputElement>('#pluginCacheTtl');
const pluginCacheStatus = document.querySelector<HTMLElement>('#pluginCacheStatus');
const pluginCacheClear = document.querySelector<HTMLButtonElement>('#pluginCacheClear');
const pluginCacheCancel = document.querySelector<HTMLButtonElement>('#pluginCacheCancel');
const pluginCacheSave = document.querySelector<HTMLButtonElement>('#pluginCacheSave');

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
let activePluginCache: { pluginId: string; label: string } | null = null;

window.setTimeout(() => {
  shell?.classList.remove('is-booting');
  introInput?.focus();
}, 650);

loadEnvStatus().catch(() => {
  setEnvLabel('');
});
initProviderOnboarding().catch(() => {
  // A host that cannot answer is a broken install, not a fresh one. Blocking
  // the app behind onboarding here would hide a working setup.
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

    // The open slash menu owns arrow/enter/tab/escape next.
    if (handleSlashKeydown(event)) return;

    if (event.key === 'Escape') {
      hideSlashMenu();
      closeModelsModal();
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
pluginCacheCancel?.addEventListener('click', closePluginCacheModal);
pluginCacheSave?.addEventListener('click', () => void saveActivePluginCacheSettings());
pluginCacheClear?.addEventListener('click', () => void clearActivePluginCache());
pluginCacheEnabled?.addEventListener('change', syncPluginCacheDurationState);
pluginCacheModal?.addEventListener('click', (event) => {
  if (event.target === pluginCacheModal) closePluginCacheModal();
});
document.addEventListener('click', (event) => {
  const target = event.target;
  if (target instanceof Element && !target.closest('.plugin-detail-actions')) {
    closePluginDetailMenu();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closePluginDetailMenu();
  if (activePluginCache) closePluginCacheModal();
  if (pendingExtensionDelete) resolveExtensionDelete(false);
});
attachExternalLinkHandler(document, async (url) => {
  try {
    await invoke('open_external_url', { url });
  } catch (error) {
    console.error('Could not open link in the browser:', getErrorMessage(error));
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

/**
 * The composer meta row names the model and the role it is playing. Where the
 * credential came from is a setup detail, so an unresolved provider leaves the
 * model half blank rather than explaining `.env` in the chat furniture.
 */
function setEnvLabel(label: string) {
  const modeSuffix = appMode === 'build' ? 'builder' : 'explorer';
  const text = label ? `${label} · ${modeSuffix}` : modeSuffix;
  if (introEnvLabel) introEnvLabel.textContent = text;
  if (chatEnvLabel) chatEnvLabel.textContent = text;
}

function renderComposerModelLabel() {
  if (!llmEnvStatus) {
    setEnvLabel('');
    return;
  }

  const isBuild = appMode === 'build';
  const provider = isBuild ? llmEnvStatus.codingProvider : llmEnvStatus.provider;
  const model = isBuild ? llmEnvStatus.codingModel : llmEnvStatus.model;

  // An OAuth provider carries no stored key, so "configured" cannot stand in
  // for "usable" here. A genuinely unconnected app is stopped by the
  // onboarding gate before it can reach this row.
  setEnvLabel(`${provider}/${model}`);
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
    setEnvLabel('');
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
  if (shell) {
    shell.dataset.mode = appMode;
  }
}

function slashMenuIsOpen(): boolean {
  return Boolean(slashMenu && !slashMenu.classList.contains('is-hidden'));
}

function syncSlashMenu(input: HTMLTextAreaElement | null) {
  if (!input || !slashMenu) return;
  const items = filterSlashCommands(input.value);
  if (!items.length) {
    hideSlashMenu();
    return;
  }

  // Keep the highlighted command as the typed prefix narrows the list.
  const previous = slashState?.items[slashState.active]?.command;
  const carried = items.findIndex((item) => item.command === previous);
  slashState = { input, items, active: carried === -1 ? 0 : carried };
  renderSlashMenu();

  const rect = input.getBoundingClientRect();
  slashMenu.style.left = `${Math.round(rect.left)}px`;
  slashMenu.style.width = `${Math.round(rect.width)}px`;
  slashMenu.classList.remove('is-hidden');
  slashMenu.setAttribute('aria-hidden', 'false');
  // Anchor above the input now that the row count is known.
  const menuRect = slashMenu.getBoundingClientRect();
  slashMenu.style.top = `${Math.max(8, Math.round(rect.top - menuRect.height - 8))}px`;
}

function renderSlashMenu() {
  if (!slashMenu || !slashState) return;
  slashMenu.innerHTML = '';
  slashState.items.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `slash-menu-item${index === slashState!.active ? ' is-active' : ''}`;
    button.dataset.command = item.command;
    const command = document.createElement('span');
    command.className = 'slash-menu-command';
    command.textContent = item.command;
    const description = document.createElement('span');
    description.className = 'slash-menu-description';
    description.textContent = item.description;
    button.append(command, description);
    // mousedown fires before the textarea blur, so clicking selects cleanly.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      void runSlashCommand(item.command, slashState?.input ?? null);
    });
    slashMenu.appendChild(button);
  });
}

function hideSlashMenu() {
  slashMenu?.classList.add('is-hidden');
  slashMenu?.setAttribute('aria-hidden', 'true');
  slashState = null;
}

// Returns true when the keystroke was consumed by the open slash menu.
function handleSlashKeydown(event: KeyboardEvent): boolean {
  if (!slashMenuIsOpen() || !slashState) return false;
  const count = slashState.items.length;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    slashState.active = (slashState.active + 1) % count;
    renderSlashMenu();
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    slashState.active = (slashState.active - 1 + count) % count;
    renderSlashMenu();
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    void runSlashCommand(slashState.items[slashState.active].command, slashState.input);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    hideSlashMenu();
    return true;
  }
  return false;
}

/** Dispatch a slash command by name. Unknown commands fall through to the model. */
async function runSlashCommand(typed: string, input: HTMLTextAreaElement | null): Promise<boolean> {
  // Matched the same way the menu filters, so "/Status" runs rather than being
  // sent to the model as a question.
  const command = typed.trim().toLowerCase();
  if (command === '/models') {
    await openModelsCommandFlow(input);
    return true;
  }
  if (command === '/status') {
    await openStatusCommandFlow(input);
    return true;
  }
  return false;
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

/**
 * Sum this chat's saved turns. Context fill comes from the most recent turn that
 * reported it, because the window describes the conversation now — not the total
 * of everything ever sent through it.
 */
function currentChatUsage(): ChatUsageSnapshot {
  const snapshot: ChatUsageSnapshot = {
    provider: '',
    model: '',
    contextTokens: 0,
    contextWindow: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    turns: 0
  };

  for (const message of storedMessages) {
    const usage = message.usage;
    if (!usage) continue;
    snapshot.input += usage.input || 0;
    snapshot.output += usage.output || 0;
    snapshot.cacheRead += usage.cacheRead || 0;
    snapshot.cacheWrite += usage.cacheWrite || 0;
    snapshot.totalTokens += usage.totalTokens || 0;
    snapshot.turns += 1;
    if (usage.contextWindow) {
      snapshot.contextTokens = usage.contextTokens || 0;
      snapshot.contextWindow = usage.contextWindow;
    }
    if (message.provider) snapshot.provider = message.provider;
    if (message.model) snapshot.model = message.model;
  }

  return snapshot;
}

async function openStatusCommandFlow(input: HTMLTextAreaElement | null) {
  if (input) input.value = '';
  hideSlashMenu();

  let totals: UsageTotals = { totals: {} };
  try {
    totals = await invoke<UsageTotals>('read_usage_totals');
  } catch {
    // An unreadable odometer is not a reason to withhold the rest of the modal.
  }

  // The provider lookup is passed in unawaited: the modal paints on local
  // numbers and swaps the account section in when the network answers.
  openStatusModal({ chat: currentChatUsage(), totals }, () =>
    invoke<ProviderQuota>('read_provider_quota')
  );
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

/**
 * Blocks the app until a provider exists, on the very first run only.
 *
 * The gate is "nothing is connected anywhere", and `connected` already counts a
 * key resolved from `.env`, so an existing install or a developer machine goes
 * straight to the chat. A failure to reach the host is not treated as an empty
 * setup — showing the splash then would hide a working app behind onboarding.
 */
async function initProviderOnboarding() {
  const result = await invoke<ModelProviderList>('list_model_providers');
  modelProviders = result.providers;
  if (needsProviderOnboarding(modelProviders)) openOnboarding();
}

/** The first-run splash as a provider-flow surface. */
function onboardingHost(): ProviderFlowHost | null {
  if (!onboardingContent) return null;
  return {
    content: onboardingContent,
    setTitle: (text) => {
      if (onboardingTitle) onboardingTitle.textContent = text;
    },
    setHint: (text) => {
      if (onboardingHint) onboardingHint.textContent = text;
    },
    onBack: () => renderOnboardingChoice(),
    onConnected: () => closeOnboarding()
  };
}

function openOnboarding() {
  onboardingOverlay?.classList.remove('is-hidden');
  onboardingOverlay?.setAttribute('aria-hidden', 'false');
  renderOnboardingChoice();
}

function closeOnboarding() {
  onboardingOverlay?.classList.add('is-hidden');
  onboardingOverlay?.setAttribute('aria-hidden', 'true');
  introInput?.focus();
}

/**
 * The first screen: one sign-in, everything else behind "Other".
 *
 * ChatGPT is not one option among equals here. It is the only provider that
 * connects without leaving for a billing console, so it gets the whole width
 * and the others get a link.
 */
function renderOnboardingChoice() {
  const host = onboardingHost();
  if (!host) return;
  host.setTitle('Please select your AI frontier model');
  host.setHint('Sign in with ChatGPT and start straight away.');
  host.content.innerHTML = '';

  const chatgpt = modelProviders.find((provider) => provider.authMethod === 'oauth');
  if (chatgpt) {
    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.className = 'onboarding-primary';
    signIn.textContent = `Sign in with ${chatgpt.name}`;
    signIn.addEventListener('click', () => void selectProvider(chatgpt, host));
    host.content.appendChild(signIn);
  }

  const other = document.createElement('button');
  other.type = 'button';
  other.className = 'onboarding-secondary';
  other.textContent = 'Other';
  other.addEventListener('click', () => renderOnboardingOther());
  host.content.appendChild(other);
}

/** The rest of the providers, each of which needs a pasted key. */
function renderOnboardingOther() {
  const host = onboardingHost();
  if (!host) return;
  host.setTitle('Connect a provider');
  host.setHint('These need an API key. Each one links to the page that issues it.');
  host.content.innerHTML = '';

  const { primary, advanced } = partitionProviders(modelProviders);
  const keyProviders = [...primary, ...advanced].filter(
    (provider) => provider.authMethod === 'api_key'
  );
  for (const provider of keyProviders) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'onboarding-choice';
    choice.innerHTML = `
      <span class="models-provider-main">
        <strong>${escapeHtml(provider.name)}</strong>
        <span>${escapeHtml(providerSubtitle(provider))}</span>
      </span>
    `;
    choice.addEventListener('click', () => void selectProvider(provider, host));
    host.content.appendChild(choice);
  }

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'onboarding-secondary';
  back.textContent = 'Back';
  back.addEventListener('click', () => renderOnboardingChoice());
  host.content.appendChild(back);
}

/** The `/models` modal as a provider-flow surface. */
function modelsModalHost(): ProviderFlowHost | null {
  if (!modelsModalContent) return null;
  return {
    content: modelsModalContent,
    setTitle: (text) => {
      if (modelsModalTitle) modelsModalTitle.textContent = text;
    },
    setHint: (text) => {
      if (modelsModalHint) modelsModalHint.textContent = text;
    },
    onBack: () => renderProviderList(),
    onConnected: () => closeModelsModal()
  };
}

function renderProviderList() {
  const host = modelsModalHost();
  if (!host) return;
  host.setTitle('Model Providers');
  host.setHint('One provider powers both Explore and Build.');
  host.content.innerHTML = '';

  const { primary, advanced } = partitionProviders(modelProviders);
  for (const provider of primary) {
    host.content.appendChild(providerRow(provider, host));
  }

  // api.openai.com still works and some people only have a key, but a ChatGPT
  // subscription is the path onboarding pushes, so the key account is a link
  // rather than a fourth row competing with it.
  for (const provider of advanced) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'models-modal-note models-advanced-link';
    link.textContent = provider.connected
      ? `Use an ${provider.name} key instead`
      : `Have an ${provider.name} key instead?`;
    link.addEventListener('click', () => void selectProvider(provider, host));
    host.content.appendChild(link);
  }
}

function providerRow(provider: ModelProvider, host: ProviderFlowHost) {
  const row = document.createElement('section');
  row.className = `models-provider-row${providerIsActive(provider) ? ' is-active' : ''}`;
  row.innerHTML = `
    <span class="models-provider-main">
      <strong>${escapeHtml(provider.name)}</strong>
      <span>${escapeHtml(providerSubtitle(provider))}</span>
      ${
        providerCanSignOut(provider)
          ? '<button type="button" class="models-provider-signout">Sign out</button>'
          : ''
      }
    </span>
    <div class="models-provider-controls">
      <button type="button" class="models-role-action${providerIsActive(provider) ? ' is-active' : ''}">
        ${providerActionLabel(provider)}
      </button>
    </div>
  `;
  row
    .querySelector<HTMLButtonElement>('.models-role-action')
    ?.addEventListener('click', () => void selectProvider(provider, host));
  row
    .querySelector<HTMLButtonElement>('.models-provider-signout')
    ?.addEventListener('click', () => void signOutProvider(provider));
  return row;
}

/**
 * The line under a provider name.
 *
 * The model is no longer editable, so the row says which one it will use rather
 * than which host it talks to — that was never the interesting part.
 */
function providerSubtitle(provider: ModelProvider) {
  return provider.chatModel || provider.defaultChatModel;
}

/**
 * Connects a provider, or starts the flow that can.
 *
 * The model is not asked for: each provider ships one default that serves both
 * roles, and `role: 'both'` is what keeps Explore and Build on it together.
 */
async function selectProvider(provider: ModelProvider, host: ProviderFlowHost) {
  if (providerNeedsAuth(provider)) {
    if (provider.authMethod === 'oauth') {
      renderOAuthSignInStep(provider, host);
    } else {
      renderApiKeyStep(provider, host);
    }
    return;
  }

  try {
    const result = await invoke<ModelProviderList>('set_active_model_provider', {
      providerId: provider.id,
      role: 'both',
      model: provider.defaultChatModel
    });
    applyConnectedProviders(result.providers);
    host.onConnected();
  } catch (error) {
    host.setHint(getErrorMessage(error, `Could not select ${provider.name}.`));
  }
}

/** Records a provider list that may have just changed which model is in use. */
function applyConnectedProviders(providers: ModelProvider[]) {
  modelProviders = providers;
  setEnvLabel(labelFromProvidersForMode(modelProviders));
}

/**
 * Collects one plugin credential at a time in the existing provider-key modal.
 * Reusing that shell keeps the secret out of the scrolling transcript and gets
 * the established password-input, Escape, and focus handling for free.
 */
function openPluginCredentialModal(
  plugin: { id: string; name: string },
  pending: PluginCredentialRequirement[],
  onDone: () => void
) {
  const remaining = pending.filter((credential) => credential.key);
  if (!remaining.length) {
    onDone();
    return;
  }
  openModelsModal();
  renderPluginCredentialStep(plugin, remaining, 0, onDone);
}

function renderPluginCredentialStep(
  plugin: { id: string; name: string },
  pending: PluginCredentialRequirement[],
  index: number,
  onDone: () => void
) {
  if (!modelsModalContent) return;
  const credential = pending[index];
  if (!credential) {
    closeModelsModal();
    onDone();
    return;
  }

  if (modelsModalTitle) modelsModalTitle.textContent = credential.label;
  if (modelsModalHint) {
    const step = pending.length > 1 ? ` (${index + 1} of ${pending.length})` : '';
    modelsModalHint.textContent = `Paste the key ${plugin.name} should use${step}.`;
  }
  modelsModalContent.innerHTML = '';

  const form = document.createElement('form');
  form.className = 'models-key-form';
  form.autocomplete = 'off';

  if (credential.description) {
    const description = document.createElement('p');
    description.className = 'models-modal-note';
    description.textContent = credential.description;
    form.appendChild(description);
  }

  if (credential.signupUrl) {
    const link = document.createElement('a');
    link.href = credential.signupUrl;
    link.className = 'models-modal-note';
    link.textContent = 'Get an API key';
    form.appendChild(link);
  }

  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'models-key-input';
  input.placeholder = credential.label;
  input.spellcheck = false;
  input.autocomplete = 'off';
  form.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'models-modal-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'models-secondary-action';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    closeModelsModal();
    onDone();
  });
  actions.appendChild(cancel);

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'models-primary-action';
  save.textContent = 'Save';
  actions.appendChild(save);
  form.appendChild(actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      if (modelsModalHint) modelsModalHint.textContent = 'API key is required.';
      return;
    }
    save.disabled = true;
    try {
      await invoke<GeneratedPluginDetail>('save_plugin_credential', {
        pluginId: plugin.id,
        key: credential.key,
        value
      });
      input.value = '';
      renderPluginCredentialStep(plugin, pending, index + 1, onDone);
    } catch (error) {
      save.disabled = false;
      if (modelsModalHint) {
        modelsModalHint.textContent = getErrorMessage(error, 'Could not save the key.');
      }
    }
  });

  modelsModalContent.appendChild(form);
  setTimeout(() => input.focus(), 0);
}

function renderApiKeyStep(provider: ModelProvider, host: ProviderFlowHost) {
  host.setTitle(provider.name);
  host.setHint(`Paste your API key to use ${provider.defaultChatModel}.`);
  host.content.innerHTML = '';

  const form = document.createElement('form');
  form.className = 'models-key-form';
  form.autocomplete = 'off';

  if (provider.apiKeyUrl) {
    // Opened through the host rather than as an <a href>: a navigation inside
    // the webview would replace the app with the provider's console.
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'models-modal-note models-advanced-link';
    link.textContent = 'Get an API key';
    link.addEventListener('click', () => {
      void invoke('open_external_url', { url: provider.apiKeyUrl });
    });
    form.appendChild(link);
  }

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
  back.addEventListener('click', () => host.onBack());
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
      host.setHint('API key is required.');
      return;
    }
    try {
      const result = await invoke<ModelProviderList>('save_provider_api_key', {
        providerId: provider.id,
        apiKey,
        role: 'both',
        model: provider.defaultChatModel
      });
      input.value = '';
      applyConnectedProviders(result.providers);
      host.onConnected();
    } catch (error) {
      host.setHint(getErrorMessage(error, `Could not save ${provider.name} key.`));
    }
  });

  host.content.appendChild(form);
  setTimeout(() => input.focus(), 0);
}

/**
 * Signs in to a provider that authenticates in the browser.
 *
 * The host opens the page and waits for the redirect, so the usual outcome is
 * that this screen just resolves. The paste field is the fallback for the one
 * failure that cannot be detected up front: pi's callback server needs a fixed
 * local port, and something else — usually the Codex CLI — may already hold it,
 * in which case the redirect never reaches us and the code has to come by hand.
 */
function renderOAuthSignInStep(provider: ModelProvider, host: ProviderFlowHost) {
  host.setTitle(provider.name);
  host.setHint(`Opening your browser to sign in, then using ${provider.defaultChatModel}.`);
  host.content.innerHTML = '';

  const streamId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `oauth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let authUrl = '';
  let settled = false;

  const status = document.createElement('p');
  status.className = 'models-oauth-status';
  status.textContent = 'Waiting for you to finish signing in...';
  host.content.appendChild(status);

  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.className = 'models-oauth-reopen';
  reopen.textContent = 'Open the sign-in page again';
  reopen.hidden = true;
  reopen.addEventListener('click', () => {
    if (authUrl) void invoke('open_external_url', { url: authUrl });
  });
  host.content.appendChild(reopen);

  const form = document.createElement('form');
  form.className = 'models-oauth-form';
  form.autocomplete = 'off';

  const label = document.createElement('label');
  label.className = 'models-oauth-label';
  label.textContent = "Browser didn't redirect? Paste the code or the redirect URL:";
  form.appendChild(label);

  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.className = 'models-key-input';
  codeInput.placeholder = 'Authorization code';
  codeInput.spellcheck = false;
  codeInput.autocomplete = 'off';
  form.appendChild(codeInput);

  const actions = document.createElement('div');
  actions.className = 'models-modal-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'models-secondary-action';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    settled = true;
    void invoke('cancel_model_chat_stream', { streamId });
    host.onBack();
  });
  actions.appendChild(cancel);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'models-primary-action';
  submit.textContent = 'Submit code';
  actions.appendChild(submit);
  form.appendChild(actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return;
    try {
      await invoke('submit_provider_oauth_code', { streamId, code });
      codeInput.value = '';
      status.textContent = 'Finishing sign-in...';
    } catch (error) {
      host.setHint(getErrorMessage(error, 'Could not submit the code.'));
    }
  });

  host.content.appendChild(form);

  const onEvent = new Channel<OAuthLoginEvent>((payload) => {
    if (payload.streamId !== streamId) return;
    if (payload.eventType === 'auth_url' && payload.url) {
      authUrl = payload.url;
      reopen.hidden = false;
    } else if (payload.eventType === 'progress' && payload.message) {
      status.textContent = payload.message;
    } else if (payload.eventType === 'error' && payload.error) {
      status.textContent = payload.error;
    }
  });

  void (async () => {
    try {
      const result = await invoke<ModelProviderList>('run_provider_oauth_login', {
        streamId,
        onEvent,
        providerId: provider.id,
        role: 'both',
        model: provider.defaultChatModel
      });
      if (settled) return;
      settled = true;
      applyConnectedProviders(result.providers);
      host.onConnected();
    } catch (error) {
      if (settled) return;
      settled = true;
      // Back first: returning to the picker rewrites the hint, so the failure
      // has to be written after it or it never gets read.
      host.onBack();
      host.setHint(getErrorMessage(error, `Could not sign in to ${provider.name}.`));
    }
  })();
}

async function signOutProvider(provider: ModelProvider) {
  try {
    const result = await invoke<ModelProviderList>('sign_out_provider', { providerId: provider.id });
    modelProviders = result.providers;
    setEnvLabel(labelFromProvidersForMode(modelProviders));
    renderProviderList();
  } catch (error) {
    if (modelsModalHint) {
      modelsModalHint.textContent = getErrorMessage(error, `Could not sign out of ${provider.name}.`);
    }
  }
}

function labelFromProvidersForMode(providers: ModelProvider[]) {
  const active = providers.find((provider) => (appMode === 'build' ? provider.codingActive : provider.chatActive));
  if (!active) return '';
  return appMode === 'build' ? `${active.id}/${active.codingModel}` : `${active.id}/${active.chatModel}`;
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
    renderSplashPrompts();
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

function renderSplashPrompts() {
  const prompts = selectSplashPrompts(generatedPlugins, DEFAULT_SPLASH_PROMPTS);
  suggestionButtons.forEach((button, index) => {
    const prompt = prompts[index];
    if (!prompt) return;
    button.textContent = prompt;
    button.dataset.suggestion = prompt;
  });
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

function closePluginDetailMenu() {
  const menu = pluginDetailView?.querySelector<HTMLElement>('.plugin-detail-menu');
  const toggle = pluginDetailView?.querySelector<HTMLButtonElement>('.plugin-detail-menu-toggle');
  menu?.classList.add('is-hidden');
  toggle?.setAttribute('aria-expanded', 'false');
}

async function openPluginCacheModal(pluginId: string, label: string) {
  if (
    !pluginCacheModal ||
    !pluginCacheEnabled ||
    !pluginCacheTtl ||
    !pluginCacheStatus
  ) {
    return;
  }
  activePluginCache = { pluginId, label };
  if (pluginCacheTitle) pluginCacheTitle.textContent = `Cache · ${label}`;
  if (pluginCacheHint) {
    pluginCacheHint.textContent = 'Reuse successful API responses until the cache duration expires.';
  }
  pluginCacheEnabled.checked = true;
  pluginCacheTtl.value = '24';
  pluginCacheStatus.textContent = 'Loading cache settings…';
  pluginCacheModal.classList.remove('is-hidden');
  pluginCacheModal.setAttribute('aria-hidden', 'false');
  setPluginCacheModalBusy(true);

  try {
    const settings = await invoke<PluginCacheSettings>('get_generated_plugin_cache_settings', {
      pluginId
    });
    if (activePluginCache?.pluginId !== pluginId) return;
    pluginCacheEnabled.checked = settings.enabled;
    pluginCacheTtl.value = String(settings.ttlHours);
    pluginCacheStatus.textContent = '';
    setPluginCacheModalBusy(false);
    pluginCacheEnabled.focus();
  } catch (error) {
    if (activePluginCache?.pluginId !== pluginId) return;
    pluginCacheStatus.textContent = getErrorMessage(error, 'Could not load cache settings.');
    setPluginCacheModalBusy(false);
  }
}

function closePluginCacheModal() {
  activePluginCache = null;
  pluginCacheModal?.classList.add('is-hidden');
  pluginCacheModal?.setAttribute('aria-hidden', 'true');
  if (pluginCacheStatus) pluginCacheStatus.textContent = '';
  pluginDetailView?.querySelector<HTMLButtonElement>('.plugin-detail-menu-toggle')?.focus();
}

function setPluginCacheModalBusy(busy: boolean) {
  if (pluginCacheModal) pluginCacheModal.dataset.busy = String(busy);
  if (pluginCacheEnabled) pluginCacheEnabled.disabled = busy;
  if (pluginCacheSave) pluginCacheSave.disabled = busy;
  if (pluginCacheClear) pluginCacheClear.disabled = busy;
  syncPluginCacheDurationState();
}

function syncPluginCacheDurationState() {
  if (!pluginCacheTtl) return;
  pluginCacheTtl.disabled =
    pluginCacheModal?.dataset.busy === 'true' || pluginCacheEnabled?.checked === false;
}

async function saveActivePluginCacheSettings() {
  if (!activePluginCache || !pluginCacheEnabled || !pluginCacheTtl || !pluginCacheStatus) return;
  const ttlHours = Number(pluginCacheTtl.value);
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 8760) {
    pluginCacheStatus.textContent = 'Cache duration must be a whole number from 1 to 8760 hours.';
    pluginCacheTtl.focus();
    return;
  }

  const { pluginId } = activePluginCache;
  setPluginCacheModalBusy(true);
  pluginCacheStatus.textContent = 'Saving…';
  try {
    await invoke<PluginCacheSettings>('save_generated_plugin_cache_settings', {
      pluginId,
      settings: { enabled: pluginCacheEnabled.checked, ttlHours }
    });
    if (activePluginCache?.pluginId === pluginId) closePluginCacheModal();
  } catch (error) {
    if (activePluginCache?.pluginId !== pluginId) return;
    pluginCacheStatus.textContent = getErrorMessage(error, 'Could not save cache settings.');
    setPluginCacheModalBusy(false);
  }
}

async function clearActivePluginCache() {
  if (!activePluginCache || !pluginCacheStatus) return;
  const { pluginId } = activePluginCache;
  setPluginCacheModalBusy(true);
  pluginCacheStatus.textContent = 'Clearing cached results…';
  try {
    await invoke('clear_generated_plugin_cache', { pluginId });
    if (activePluginCache?.pluginId !== pluginId) return;
    pluginCacheStatus.textContent = 'Cached API responses cleared.';
    setPluginCacheModalBusy(false);
  } catch (error) {
    if (activePluginCache?.pluginId !== pluginId) return;
    pluginCacheStatus.textContent = getErrorMessage(error, 'Could not clear cached results.');
    setPluginCacheModalBusy(false);
  }
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
    <div class="plugin-detail-actions">
      <button class="plugin-detail-menu-toggle" type="button" aria-label="Plugin options" aria-haspopup="menu" aria-expanded="false">
        ${iconSvg('ellipsis')}
      </button>
      <div class="plugin-detail-menu is-hidden" role="menu">
        <button type="button" role="menuitem" data-plugin-action="cache">
          ${iconSvg('database')}
          <span>Cache</span>
        </button>
        <button type="button" role="menuitem" class="is-danger" data-plugin-action="delete">
          ${iconSvg('trash-2')}
          <span>Delete</span>
        </button>
      </div>
    </div>
  `;
  const menuToggle = header.querySelector<HTMLButtonElement>('.plugin-detail-menu-toggle');
  const menu = header.querySelector<HTMLElement>('.plugin-detail-menu');
  menuToggle?.addEventListener('click', () => {
    const opening = menu?.classList.contains('is-hidden') ?? false;
    menu?.classList.toggle('is-hidden', !opening);
    menuToggle.setAttribute('aria-expanded', String(opening));
  });
  header.querySelector<HTMLButtonElement>('[data-plugin-action="cache"]')?.addEventListener('click', () => {
    closePluginDetailMenu();
    void openPluginCacheModal(plugin.id, plugin.name);
  });
  header.querySelector<HTMLButtonElement>('[data-plugin-action="delete"]')?.addEventListener('click', () => {
    closePluginDetailMenu();
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

  renderPluginCredentials(plugin);
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
  pluginDetailView.appendChild(createPluginCodeSection('tools.ts', detail.code || '// No tools.ts found.'));
}

// Preview every plugin tool's result card using synthesized example data.
function renderPluginCredentials(plugin: GeneratedPlugin) {
  if (!pluginDetailView) return;
  const section = document.createElement('section');
  section.className = 'plugin-detail-section';
  section.innerHTML = '<h2>Credentials</h2>';

  const declared = plugin.credentials || [];
  if (!declared.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-detail-empty';
    empty.textContent = 'This plugin does not require credentials.';
    section.appendChild(empty);
    pluginDetailView.appendChild(section);
    return;
  }

  const list = document.createElement('div');
  list.className = 'plugin-credential-list';
  for (const credential of declared) {
    const row = document.createElement('div');
    row.className = 'plugin-credential-row';

    const heading = document.createElement('div');
    heading.className = 'plugin-credential-heading';
    const label = document.createElement('strong');
    label.textContent = credential.label;
    heading.appendChild(label);
    const pill = document.createElement('span');
    pill.className = `plugin-credential-pill${credential.configured ? ' is-configured' : ''}`;
    pill.textContent = credential.configured ? 'Configured' : 'Not configured';
    heading.appendChild(pill);
    row.appendChild(heading);

    const detail = document.createElement('p');
    const code = document.createElement('code');
    code.textContent = credential.key;
    detail.appendChild(code);
    if (credential.description) {
      detail.appendChild(document.createTextNode(` ${credential.description}`));
    }
    row.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'plugin-credential-actions';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'capability-primary-action';
    save.textContent = credential.configured ? 'Replace' : 'Add key';
    save.addEventListener('click', () => {
      openPluginCredentialModal(plugin, [credential], () => {
        void openGeneratedPlugin(plugin.id);
      });
    });
    actions.appendChild(save);

    if (credential.configured) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'capability-secondary-action';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await invoke<GeneratedPluginDetail>('delete_plugin_credential', {
            pluginId: plugin.id,
            key: credential.key
          });
          await openGeneratedPlugin(plugin.id);
        } catch (error) {
          remove.disabled = false;
          detail.textContent = getErrorMessage(error, 'Could not remove the key.');
        }
      });
      actions.appendChild(remove);
    }

    if (credential.signupUrl) {
      // Stays visible after the key is stored: this is also where the user goes
      // to rotate one.
      const link = document.createElement('a');
      link.href = credential.signupUrl;
      link.className = 'plugin-credential-link';
      link.textContent = 'Get an API key';
      actions.appendChild(link);
    }

    row.appendChild(actions);
    list.appendChild(row);
  }

  section.appendChild(list);
  pluginDetailView.appendChild(section);
}

function renderPluginCardPreviews(plugin: GeneratedPlugin) {
  if (!pluginDetailView) return;
  const cardTools = plugin.tools;

  const section = document.createElement('section');
  section.className = 'plugin-detail-section';
  section.innerHTML = '<h2>Result cards</h2>';

  if (!cardTools.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-detail-empty';
    empty.textContent = 'No valid runtime tools were discovered for this plugin.';
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
  const recovered = recoverInterruptedMessages(chat.messages);
  bindChatState({
    chatId: chat.chatId,
    name: chat.name,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    activeBuildPlugin: chat.activeBuildPlugin
  }, recovered.messages);
  if (recovered.recovered) {
    await persistChatSnapshot(activeChatMeta, storedMessages);
    await refreshChatHistory();
  }
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
  const article = addMessage(
    message.role,
    message.builderRun ? '' : message.text,
    false,
    message.role === 'assistant',
    messageContext(message)
  );
  renderedMessageArticles.set(message, article);
  if (message.modeStatus) article.classList.add('mode-status-message');
  if (message.role === 'assistant' && message.builderRun) {
    const body = article.querySelector<HTMLElement>('.message-text');
    if (body) {
      const live = message.status === 'running' && chatRuns.has(activeSessionId);
      renderBuilderRun(body, message, live);
    }
  }
  if (message.role === 'assistant' && message.credentialRequest) {
    const body = article.querySelector<HTMLElement>('.message-text');
    if (body) renderCredentialRequest(body, message);
  }
  if (message.role === 'assistant' && message.modelFailure) {
    const body = article.querySelector<HTMLElement>('.message-text');
    if (body) renderModelFailure(body, message.modelFailure);
  }
  if (message.role === 'assistant' && message.cards?.length) {
    renderMessageCards(article, message.cards);
  }
  // Returning to a chat whose turn is still running: restore the liveness row so
  // a backgrounded run does not look like it was dropped.
  if (message.role === 'assistant' && !message.builderRun && message.status === 'running') {
    const live = chatRuns.get(activeSessionId)?.kind === 'agent';
    setAgentActivity(article, agentActivityLabel({ running: live, streaming: false }));
  }
}

/**
 * Render a provider failure as a notice rather than an assistant answer.
 *
 * A raw `429 The engine is currently overloaded` in an ordinary bubble reads as
 * something the app or the plugin did. The title says who stopped, the detail
 * says whether it is worth trying again, and the provider's own words stay
 * available underneath for debugging without dominating the message.
 */
function renderModelFailure(
  container: HTMLElement,
  failure: { title: string; detail: string; raw: string }
) {
  container.innerHTML = '';
  const notice = document.createElement('section');
  notice.className = 'message-error';

  const title = document.createElement('h3');
  title.textContent = failure.title;
  notice.appendChild(title);

  const detail = document.createElement('p');
  detail.textContent = failure.detail;
  notice.appendChild(detail);

  // Only worth showing when it says more than the copy above already does.
  if (failure.raw && failure.raw !== failure.detail) {
    const disclosure = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Provider response';
    disclosure.appendChild(summary);
    const raw = document.createElement('pre');
    raw.textContent = failure.raw;
    disclosure.appendChild(raw);
    notice.appendChild(disclosure);
  }

  container.appendChild(notice);
}

/**
 * Mirror an Explore turn's liveness line into a message article. Kept as a
 * sibling of `.message-text` so a body re-render (syncRemountedRun) leaves it
 * alone, and always moved last so it reads as the trailing "still working" row.
 */
function setAgentActivity(article: HTMLElement | null, label: string | null) {
  if (!article) return;
  let row = article.querySelector<HTMLElement>(':scope > .agent-activity');
  if (!label) {
    row?.remove();
    return;
  }
  if (!row) {
    row = document.createElement('div');
    row.className = 'agent-activity';
    const dot = document.createElement('span');
    dot.className = 'agent-activity-dot';
    row.appendChild(dot);
    row.appendChild(document.createElement('span'));
  }
  if (row.parentElement !== article || row !== article.lastElementChild) {
    article.appendChild(row);
  }
  const text = row.querySelector('span:last-child');
  if (text && text.textContent !== label) text.textContent = label;
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

/** The display name of the plugin that owns a runtime tool, for citations. */
function pluginNameForTool(toolName: string): string | undefined {
  return generatedPlugins.find((plugin) => plugin.tools.some((tool) => tool.name === toolName))
    ?.name;
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
  if (await runSlashCommand(content, input)) return;

  input.value = '';
  appendUserTurn(content);
  await startAgentTurn(content);
}

/** Adds the user's message to the transcript and history. */
function appendUserTurn(content: string) {
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
}

/**
 * Runs one Explore turn for an already-recorded question.
 *
 * Split out of submitMessage so the credential card's Continue button can retry
 * the original question without pushing a duplicate user bubble or a duplicate
 * entry into the model-visible history.
 */
async function startAgentTurn(content: string) {
  if (!messages || chatRuns.has(activeSessionId)) return;

  // Every ordinary user turn starts in Explore. Build is entered only from the
  // explicit plugin-writing confirmation below.
  void switchAppModeWithStatus(automaticModeForUserTurn());

  const pending = addMessage('assistant', '', true);
  const pendingBody = pending.querySelector<HTMLElement>('.message-text');
  const thinkingPreview = document.createElement('div');
  thinkingPreview.className = 'thinking-preview';
  // Inserted on the first reasoning delta; the activity row below carries the
  // "still working" signal until then.
  let streamed = '';
  let thinking = '';
  let activeToolName: string | undefined;
  // Set while the sidecar waits out a transient provider failure, and cleared by
  // the first sign the resumed round is running.
  let pendingRetry: AgentRetryEvent | undefined;
  // The stream's own error event, which carries the provider identity that the
  // rejected command drops.
  let streamError: AgentErrorEvent | undefined;
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
  /**
   * Keep the pulsing "still working" row in step with the turn's state. This
   * deliberately does NOT check turnIsActive: while the user is off in a plugin
   * view the article is still mounted, and skipping the update there would strand
   * a pulsing row on a turn that has already finished.
   */
  const refreshActivity = (running = true) => {
    const article = renderedMessageArticles.get(assistantRecord) ?? pending;
    if (!article?.isConnected) return;
    setAgentActivity(
      article,
      agentActivityLabel({
        running,
        streaming: Boolean(streamed),
        toolName: activeToolName,
        retry: pendingRetry
      })
    );
  };
  const snapshotPersister = createTurnSnapshotPersister(() =>
    persistChatSnapshotQuietly(turnMeta, turnStored)
  );
  syncRunControls();
  renderChatHistory();
  refreshActivity();
  await persistChatSnapshot(turnMeta, turnStored);
  void logAgentTurnEvent('turn_start', {
    mode: turnMode,
    userMessage: content
  }, turnSessionId);

  try {
    let requestedBuild: AgentBuildRequest | undefined;
    let requestedCredential: CredentialRequest | undefined;
    /**
     * Set the moment the turn's reply is in hand.
     *
     * The stream promise can resolve while channel events are still queued: the
     * completion path renders the final Markdown and then awaits the snapshot
     * write, which lets a trailing delta run and overwrite the message body with
     * raw streamed text and the record's status back to "running". A chat left
     * with a rendered chart replaced by its own JSON fence is that race. After
     * the reply arrives, no stream event may touch this turn.
     */
    let settled = false;
    const reply = await runMainAgentStream(turnChatMessages, turnMode, {
      onStreamId: (streamId) => {
        chatRuns.setStreamId(turnSessionId, run.id, streamId);
        syncRunControls();
        void logAgentTurnEvent('stream_id', { streamId }, turnSessionId);
      },
      onDelta: (delta) => {
        if (settled) return;
        // Output is proof the resumed round is running again.
        pendingRetry = undefined;
        streamed += delta;
        assistantRecord.text = streamed || 'Thinking...';
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        snapshotPersister.schedule();
        if (turnIsActive()) {
          const pinned = isNearBottom(messages);
          if (pendingBody) pendingBody.textContent = streamed;
          if (thinkingPreview.parentElement) thinkingPreview.remove();
          refreshActivity();
          if (pinned) scrollMessagesToBottom();
        }
        syncRemountedTurn();
      },
      onThinkingDelta: (delta) => {
        if (settled) return;
        pendingRetry = undefined;
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
          if (!thinkingPreview.parentElement) pending.prepend(thinkingPreview);
          if (pinned) scrollMessagesToBottom();
        }
        syncRemountedTurn();
      },
      onToolCall: (toolCall) => {
        if (settled) return;
        pendingRetry = undefined;
        assistantRecord.text = streamed || `Running ${toolCall.toolName}...`;
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        activeToolName = toolCall.toolName;
        refreshActivity();
        snapshotPersister.schedule(true);
        syncRemountedTurn();
        void logAgentTurnEvent('tool_call', {
          toolName: toolCall.toolName,
          args: toolCall.args
        }, turnSessionId);
      },
      onToolResult: (toolCall) => {
        if (settled) return;
        assistantRecord.text = streamed || `Ran ${toolCall.toolName}.`;
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'running';
        activeToolName = undefined;
        refreshActivity();
        const resultCard = extractResultCard(toolCall);
        let cardIndex: number | undefined;
        if (resultCard) {
          cardIndex = (assistantRecord.cards ??= []).push(resultCard) - 1;
          if (turnIsActive()) renderMessageCards(pending, assistantRecord.cards);
        }
        const source = extractToolSource(
          toolCall.result,
          toolCall.toolName,
          pluginNameForTool(toolCall.toolName)
        );
        // A citation opens the card this same call rendered.
        if (source && cardIndex !== undefined) source.cardIndex = cardIndex;
        if (source) (assistantRecord.sources ??= []).push(source);
        snapshotPersister.schedule(true);
        syncRemountedTurn();
        void logAgentTurnEvent('tool_result', {
          toolName: toolCall.toolName,
          args: toolCall.args,
          result: toolCall.result
        }, turnSessionId);
      },
      onToolError: (toolCall) => {
        if (settled) return;
        activeToolName = undefined;
        refreshActivity();
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
      },
      onCredentialRequest: (request) => {
        requestedCredential = request;
        void logAgentTurnEvent('credential_request', { request, mode: turnMode }, turnSessionId);
      },
      onRetry: (event) => {
        // The turn is deliberately idle for the length of the backoff. Saying so
        // is the difference between a visible wait and an app that looks hung.
        pendingRetry = event;
        activeToolName = undefined;
        refreshActivity();
        syncRemountedTurn();
        void logAgentTurnEvent('model_retry', event, turnSessionId);
      },
      onError: (event) => {
        streamError = event;
      }
    });
    settled = true;
    if (thinkingPreview.parentElement) {
      thinkingPreview.remove();
    }

    if (requestedCredential) {
      // Unlike the build-request path, the assistant record is kept: the turn
      // may already have produced result cards from other plugins, and this is
      // also what persists the prompt across navigation and restart.
      activeToolName = undefined;
      const copy = credentialPromptCopy(requestedCredential);
      assistantRecord.text = copy.title;
      assistantRecord.thinking = thinking.trim() || undefined;
      assistantRecord.status = 'completed';
      assistantRecord.error = undefined;
      assistantRecord.credentialRequest = requestedCredential;
      if (turnIsActive() && pendingBody) {
        pending.classList.remove('pending');
        renderCredentialRequest(pendingBody, assistantRecord);
      }
      snapshotPersister.schedule(true);
      syncRemountedTurn();
      return;
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
      if (pendingBody) {
        renderMessageText(pendingBody, finalContent, true, messageContext(assistantRecord));
      }
      pending.classList.remove('pending');
      turnChatMessages.push({ role: 'assistant', content: finalContent });
    }
    assistantRecord.text = finalContent;
    assistantRecord.timestamp = Date.now();
    assistantRecord.thinking = thinking.trim() || undefined;
    assistantRecord.provider = reply.provider;
    assistantRecord.model = reply.model;
    assistantRecord.usage = reply.usage;
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
    // The rejected command carries only a string; the stream's error event is
    // where the provider identity and the resume count live.
    const failure = describeModelFailure(streamError?.error || errorMessage, {
      provider: streamError?.provider,
      model: streamError?.model,
      role: 'chat',
      resumeAttempts: streamError?.resumeAttempts
    });
    if (turnIsActive()) {
      pending.remove();
      const article = addMessage('assistant', '');
      const body = article.querySelector<HTMLElement>('.message-text');
      if (body) renderModelFailure(body, failure);
    }
    assistantRecord.text = `${failure.title} — ${failure.detail}`;
    assistantRecord.timestamp = Date.now();
    assistantRecord.thinking = thinking.trim() || undefined;
    assistantRecord.status = 'error';
    assistantRecord.error = errorMessage;
    assistantRecord.modelFailure = failure;
    assistantRecord.provider = streamError?.provider;
    assistantRecord.model = streamError?.model;
    await persistChatSnapshot(turnMeta, turnStored);
    void logAgentTurnEvent('turn_error', {
      error: errorMessage,
      provider: streamError?.provider,
      model: streamError?.model,
      resumeAttempts: streamError?.resumeAttempts ?? 0,
      streamed,
      thinking
    }, turnSessionId);
    await refreshChatHistory();
    syncRemountedTurn();
  } finally {
    activeToolName = undefined;
    refreshActivity(false);
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
    } else if (body && record.modelFailure) {
      // Re-rendering as text here would flatten the failure notice back into
      // something that looks like an assistant answer.
      renderModelFailure(body, record.modelFailure);
    } else if (body) {
      renderMessageText(body, record.text, record.role === 'assistant', messageContext(record));
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
  const copy = pluginWriteConfirmationCopy(request.name, request.auth);

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

  if (copy.authNotice) {
    const notice = document.createElement('p');
    notice.className = 'capability-auth-notice';
    notice.textContent = copy.authNotice;
    if (copy.signupUrl) {
      notice.appendChild(document.createTextNode(' '));
      const link = document.createElement('a');
      link.href = copy.signupUrl;
      link.textContent = copy.signupLabel;
      notice.appendChild(link);
    }
    panel.appendChild(notice);
  }

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
      conflictStrategy: 'error',
      messages: recentBuildConversation()
    });
  });
}

/**
 * The "this plugin needs an API key" card.
 *
 * Rendered both live and when replaying history, so it re-reads which keys are
 * stored every time rather than trusting anything persisted. That makes it
 * self-healing when the key was added from the plugin detail screen instead.
 */
function renderCredentialRequest(
  body: HTMLElement,
  record: StoredChatMessage,
  options: { allowContinue?: boolean } = {}
) {
  const request = record.credentialRequest;
  if (!request) return;
  const allowContinue = options.allowContinue !== false;
  const copy = credentialPromptCopy(request);

  const draw = (plugin: GeneratedPlugin | null) => {
    const configured = allCredentialsConfigured(request, plugin);
    const missingKeys = new Set(missingCredentialKeys(request, plugin));
    body.innerHTML = '';

    const panel = document.createElement('section');
    panel.className = 'capability-confirmation credential-request';

    const title = document.createElement('h3');
    title.textContent = configured ? `${request.pluginName} is ready` : copy.title;
    panel.appendChild(title);

    const description = document.createElement('p');
    description.textContent = configured
      ? 'The key is saved. Continue to run your request.'
      : copy.description;
    panel.appendChild(description);

    if (!configured) {
      for (const credential of request.credentials) {
        if (!missingKeys.has(credential.key)) continue;
        const row = document.createElement('p');
        row.className = 'capability-request-summary';
        const label = document.createElement('strong');
        label.textContent = credential.label;
        row.appendChild(label);
        if (credential.description) {
          row.appendChild(document.createTextNode(` — ${credential.description}`));
        }
        if (credential.signupUrl) {
          row.appendChild(document.createTextNode(' '));
          const link = document.createElement('a');
          link.href = credential.signupUrl;
          link.textContent = copy.signupLabel;
          row.appendChild(link);
        }
        panel.appendChild(row);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'capability-actions';

    if (configured) {
      if (allowContinue) {
        const retryPrompt = retryPromptFor(storedMessages, storedMessages.indexOf(record));
        const proceed = document.createElement('button');
        proceed.type = 'button';
        proceed.className = 'capability-primary-action';
        proceed.textContent = copy.continueLabel;
        // One run per chat: a run already in flight owns the composer.
        proceed.disabled = !retryPrompt || chatRuns.has(activeSessionId);
        proceed.addEventListener('click', () => {
          if (!retryPrompt || chatRuns.has(activeSessionId)) return;
          proceed.disabled = true;
          void startAgentTurn(retryPrompt);
        });
        actions.appendChild(proceed);
      }
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'capability-primary-action';
      add.textContent = copy.addLabel;
      add.addEventListener('click', () => {
        const pendingCredentials = request.credentials.filter((credential) =>
          missingKeys.has(credential.key)
        );
        openPluginCredentialModal(
          { id: request.pluginId, name: request.pluginName },
          pendingCredentials,
          () => {
            void refresh();
          }
        );
      });
      actions.appendChild(add);

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'capability-secondary-action';
      dismiss.textContent = copy.dismissLabel;
      dismiss.addEventListener('click', () => {
        body.textContent = copy.title;
      });
      actions.appendChild(dismiss);
    }

    if (actions.childElementCount) panel.appendChild(actions);
    body.appendChild(panel);
  };

  const refresh = async () => {
    try {
      const detail = await invoke<GeneratedPluginDetail>('read_generated_plugin', {
        pluginId: request.pluginId
      });
      draw(detail.plugin);
    } catch {
      // An unreadable plugin (uninstalled mid-conversation) still gets the
      // prompt, just without a configured state.
      draw(null);
    }
  };

  draw(null);
  void refresh();
}

/**
 * Asks for the key as soon as a build finishes, rather than letting the user
 * discover the gap on their next question. The build itself never needs one —
 * the builder validates against mocked tests.
 */
async function appendPostBuildCredentialPrompt(
  pluginId: string,
  context: {
    turnMeta: ChatMeta;
    turnStored: StoredChatMessage[];
    turnIsActive: () => boolean;
  }
) {
  let plugin: GeneratedPlugin;
  try {
    const detail = await invoke<GeneratedPluginDetail>('read_generated_plugin', { pluginId });
    plugin = detail.plugin;
  } catch {
    return;
  }

  const missing = (plugin.credentials || []).filter((credential) => !credential.configured);
  if (!missing.length) return;

  const request: CredentialRequest = {
    pluginId: plugin.id,
    pluginName: plugin.name,
    credentials: missing.map((credential) => ({
      key: credential.key,
      label: credential.label,
      description: credential.description,
      signupUrl: credential.signupUrl
    }))
  };

  const record: StoredChatMessage = {
    role: 'assistant',
    text: credentialPromptCopy(request).title,
    timestamp: Date.now(),
    status: 'completed',
    credentialRequest: request
  };
  context.turnStored.push(record);

  if (context.turnIsActive()) {
    const article = addMessage('assistant', '');
    renderedMessageArticles.set(record, article);
    const body = article.querySelector<HTMLElement>('.message-text');
    // No pending question to retry here, so Continue would have nothing to do.
    if (body) renderCredentialRequest(body, record, { allowContinue: false });
  }
}

/**
 * The turns the coding agent should see.
 *
 * A build request carries only the capability description, so without this the
 * builder never learns what the user actually asked for or what an earlier
 * attempt was told. Trimmed here; the sidecar recap trims again.
 */
function recentBuildConversation(): ChatMessage[] {
  return chatMessages.slice(-12);
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
          editMode: shouldUsePluginEditMode(status),
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
        messages: options.messages,
        auth: request.auth
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
    await appendPostBuildCredentialPrompt(plugin.id, {
      turnMeta,
      turnStored,
      turnIsActive
    });
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
  // The stream's error event, which carries the provider identity the rejected
  // command drops.
  let builderStreamError: AgentErrorEvent | undefined;
  const renderLive = () => {
    if (turnIsActive()) {
      // Measure BEFORE the render: only follow new output when the user is
      // already at the bottom. Scrolling unconditionally made it impossible to
      // read back through a build while it was still running.
      const pinned = isNearBottom(messages);
      renderBuilderRun(builderRun, builderRecord, true);
      if (pinned) scrollMessagesToBottom();
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
      // The prose belongs where it was written. `text` keeps the whole
      // narration for model continuity and history previews; only the
      // rendering moves into the timeline.
      builderRecord.builderActivities = applyBuilderOutputDelta(
        builderRecord.builderActivities || [],
        delta
      );
      snapshotPersister.schedule();
      renderLive();
    },
    onStatus: (status) => {
      builderRecord.builderActivities = applyBuilderStatusEvent(
        builderRecord.builderActivities || [],
        status
      );
      snapshotPersister.schedule();
      renderLive();
    },
    onThinkingDelta: (delta) => {
      // Reasoning goes into the same timeline as the tool calls, so the run
      // reads in the order it happened rather than as one block up top.
      builderRecord.builderActivities = applyBuilderThinkingDelta(
        builderRecord.builderActivities || [],
        delta
      );
      thinking = collectBuilderReasoning(builderRecord.builderActivities);
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
    },
    onRetry: (event) => {
      // A coding pass has no streaming answer to fall silent, so the wait has to
      // be said out loud in the timeline or the build looks abandoned. It is a
      // host-side wait, not model reasoning, so it goes on the status track.
      const label = agentActivityLabel({ running: true, streaming: false, retry: event });
      builderRecord.builderActivities = applyBuilderStatusEvent(
        builderRecord.builderActivities || [],
        label || 'Retrying'
      );
      snapshotPersister.schedule(true);
      renderLive();
      void logAgentTurnEvent('model_retry', event, run.chatId);
    },
    onError: (event) => {
      builderStreamError = event;
    }
  }).catch((error: unknown) => {
    // Attribute the failure before it reaches the generic build-failed handler,
    // which would otherwise report an overloaded provider as a broken plugin.
    if (!builderStreamError) throw error;
    const failure = describeModelFailure(builderStreamError.error || getErrorMessage(error), {
      provider: builderStreamError.provider,
      model: builderStreamError.model,
      role: 'builder',
      resumeAttempts: builderStreamError.resumeAttempts
    });
    builderRecord.provider = builderStreamError.provider;
    builderRecord.model = builderStreamError.model;
    builderRecord.modelFailure = failure;
    throw new Error(`${failure.title} — ${failure.detail}`);
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
  await refreshGeneratedPlugins();
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

  const activitiesForThinking = message.builderActivities || [];
  // Reasoning now lives inline in the timeline. The collected block is kept
  // only for chats recorded before that, which have thinking but no reasoning
  // entries to interleave.
  const hasInlineReasoning = activitiesForThinking.some(isReasoningActivity);

  // Thinking block (legacy chats only).
  let thinking = container.querySelector<HTMLDetailsElement>(':scope > .builder-thinking');
  if (message.thinking && !hasInlineReasoning) {
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
    reconcileBuilderTimeline(timeline, activities, live && message.status === 'running');
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

  // Final summary text. Suppressed once the narration is interleaved, since the
  // closing message is then the last timeline entry; kept for chats recorded
  // before that, which have no output entries to show.
  const hasInlineOutput = activitiesForThinking.some(isOutputActivity);
  const showSummary =
    !hasInlineOutput &&
    Boolean(
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
function reconcileBuilderTimeline(
  timeline: HTMLElement,
  activities: BuilderActivity[],
  live: boolean
) {
  const existingIds = Array.from(timeline.children).map(
    (child) => (child as HTMLElement).dataset.toolCallId || ''
  );
  const { ops, length } = planBuilderTimeline(existingIds, activities);
  for (const op of ops) {
    const activity = activities[op.index];
    const existing = timeline.children[op.index] as HTMLElement | undefined;
    if (isReasoningActivity(activity)) {
      // A slot can change kind only by insertion, since ids never collide.
      if (op.action === 'reuse' && existing) {
        updateBuilderReasoningCard(existing, activity);
      } else {
        timeline.insertBefore(
          renderBuilderReasoningCard(activity),
          timeline.children[op.index] ?? null
        );
      }
      continue;
    }
    if (isStatusActivity(activity)) {
      if (op.action === 'reuse' && existing) {
        updateBuilderStatusCard(existing, activity);
      } else {
        timeline.insertBefore(
          renderBuilderStatusCard(activity),
          timeline.children[op.index] ?? null
        );
      }
      continue;
    }
    if (isOutputActivity(activity)) {
      // Markdown once the block is settled: still-streaming prose renders as
      // plain text, matching how the bottom summary has always behaved.
      const settled = op.index < activities.length - 1 || !live;
      if (op.action === 'reuse' && existing) {
        updateBuilderOutputCard(existing, activity, settled);
      } else {
        timeline.insertBefore(
          renderBuilderOutputCard(activity, settled),
          timeline.children[op.index] ?? null
        );
      }
      continue;
    }
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

function renderBuilderOutputCard(activity: BuilderOutputActivity, settled: boolean) {
  const card = document.createElement('div');
  card.className = 'builder-output message-text';
  card.dataset.toolCallId = activity.toolCallId;
  updateBuilderOutputCard(card, activity, settled);
  return card;
}

function updateBuilderOutputCard(
  card: HTMLElement,
  activity: BuilderOutputActivity,
  settled: boolean
) {
  if (card.className !== 'builder-output message-text') {
    card.className = 'builder-output message-text';
  }
  if (card.dataset.toolCallId !== activity.toolCallId) {
    card.dataset.toolCallId = activity.toolCallId;
  }
  const text = activity.text.trim();
  const signature = `${settled ? 'md' : 'raw'}:${text}`;
  // Re-rendering Markdown on every delta would thrash; only redraw on change.
  if (card.dataset.rendered === signature) return;
  card.dataset.rendered = signature;
  renderMessageText(card, text, settled);
}

function renderBuilderStatusCard(activity: BuilderStatusActivity) {
  const card = document.createElement('div');
  card.className = 'builder-status';
  card.dataset.toolCallId = activity.toolCallId;
  updateBuilderStatusCard(card, activity);
  return card;
}

function updateBuilderStatusCard(card: HTMLElement, activity: BuilderStatusActivity) {
  if (card.className !== 'builder-status') card.className = 'builder-status';
  if (card.dataset.toolCallId !== activity.toolCallId) {
    card.dataset.toolCallId = activity.toolCallId;
  }
  const label = builderStatusLabel(activity.status);
  if (card.textContent !== label) card.textContent = label;
}

function renderBuilderReasoningCard(activity: BuilderReasoningActivity) {
  const card = document.createElement('div');
  card.className = 'builder-reasoning';
  card.dataset.toolCallId = activity.toolCallId;
  const text = document.createElement('div');
  text.className = 'builder-reasoning-text';
  card.appendChild(text);
  updateBuilderReasoningCard(card, activity);
  return card;
}

function updateBuilderReasoningCard(card: HTMLElement, activity: BuilderReasoningActivity) {
  if (card.className !== 'builder-reasoning') card.className = 'builder-reasoning';
  if (card.dataset.toolCallId !== activity.toolCallId) {
    card.dataset.toolCallId = activity.toolCallId;
  }
  let text = card.querySelector<HTMLElement>('.builder-reasoning-text');
  if (!text) {
    text = document.createElement('div');
    text.className = 'builder-reasoning-text';
    card.appendChild(text);
  }
  const value = activity.text.trim();
  if (text.textContent !== value) text.textContent = value;
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
  // Hovering reveals the full path/command that the preview truncates.
  const summary = details.querySelector<HTMLElement>(':scope > summary');
  const subject = `${activity.toolName} — ${builderToolArgsSubject(activity.args)}`;
  if (summary && summary.title !== subject) summary.title = subject;
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
  return builderToolArgsSubject(args).slice(0, 90);
}

/**
 * The full, untruncated subject of a tool call — the file it writes, the
 * command it runs, the pattern it searches. Shown as the hover title so a
 * truncated preview never hides which file a write touched.
 */
function builderToolArgsSubject(args: Record<string, unknown>) {
  for (const key of ['path', 'file_path', 'filePath', 'command', 'query', 'pattern']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ');
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
      conflictStrategy: 'replace',
      messages: recentBuildConversation()
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
      name,
      messages: recentBuildConversation()
    });
  });

  autoName.addEventListener('click', () => {
    disableActions();
    void scaffoldAndRunPluginBuilder(request, body, persistAssistantStatus, {
      conflictStrategy: 'rename',
      messages: recentBuildConversation()
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

function addMessage(
  role: ChatMessage['role'],
  content: string,
  pending = false,
  markdown = false,
  context: MessageContext = EMPTY_MESSAGE_CONTEXT
) {
  if (!messages) {
    throw new Error('Missing messages container');
  }

  const article = document.createElement('article');
  article.className = `message ${role}${pending ? ' pending' : ''}`;

  const body = document.createElement('div');
  body.className = 'message-text';
  renderMessageText(body, content, markdown, context);

  article.appendChild(body);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;

  return article;
}

/**
 * The turn's API calls travel with the text: a chart copied out of the message
 * has to name them, and a citation has to open the card one of them rendered.
 * Both are inert for every block that is not a chart, table, or citation.
 */
function renderMessageText(
  container: HTMLElement,
  text: string,
  markdown = false,
  context: MessageContext = EMPTY_MESSAGE_CONTEXT
) {
  if (!markdown) {
    container.textContent = text;
    return;
  }

  renderMarkdown(container, text, context);
  if (!container.childNodes.length) {
    container.textContent = text;
  }
}

function renderMarkdown(
  container: HTMLElement,
  text: string,
  context: MessageContext = EMPTY_MESSAGE_CONTEXT
) {
  // Charts own a React root; release it before the node is discarded below.
  container.querySelectorAll<HTMLElement>('[data-chart-root]').forEach(unmountChart);
  container.textContent = '';
  const sourceText = String(text || '');
  const sourceLines = sourceText.replace(/\r\n?/g, '\n').split('\n');

  if (sourceText.length > MAX_MARKDOWN_RENDER_LENGTH || sourceLines.length > MAX_MARKDOWN_RENDER_LINES) {
    container.textContent = sourceText;
    return;
  }

  renderMarkdownLightweight(container, sourceText, sourceLines, context);
}

/**
 * Cites the turn's API calls beneath a chart or table.
 *
 * These sources are turn-level, so every data block in one answer carries the
 * same line — the same claim the copied image makes. It is the fallback for an
 * answer that cites nothing inline; when the model placed `[^n]` markers, those
 * are the more precise attribution and this line would only repeat them.
 */
function appendCitationLine(
  container: HTMLElement,
  context: MessageContext,
  suppressed: boolean
) {
  if (suppressed) return;
  const line = createCitationLine(context.sources, context.cards);
  if (line) container.appendChild(line);
}

function renderMarkdownLightweight(
  container: HTMLElement,
  sourceText: string,
  sourceLines: string[],
  context: MessageContext = EMPTY_MESSAGE_CONTEXT
) {
  // Decided up front: a marker can sit anywhere in the answer, including after
  // the chart or table whose block line it would replace.
  const cited = citedCitationNumbers(sourceText, context.sources);
  const citedInline = cited.length > 0;
  // A copied image has no click target, so it names its sources instead —
  // narrowed to what the answer cited when it cited anything.
  const sourceEntries = chartSourceEntries(context.sources, cited);
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
      // A ```chart fence carries a JSON spec the host draws with Recharts. An
      // unparseable spec falls through to the ordinary code block below so the
      // model's output is never swallowed.
      if (language === 'chart') {
        const spec = parseChartSpec(block.join('\n'));
        if (spec) {
          // A chart cites what it plotted, which only the spec knows: the turn's
          // other calls found the data rather than supplying it.
          const plotted = spec.sources ?? [];
          const chartEntries = plotted.length
            ? chartSourceEntries(context.sources, plotted)
            : sourceEntries;
          const chart = document.createElement('div');
          chart.dataset.chartRoot = 'true';
          const wrapper = wrapCopyable(chart, 'Copy chart', () => ({
            text: chartSpecToMarkdown(spec),
            image: () => chartRootToPngBlob(chart, spec, chartEntries)
          }));
          wrapper.classList.add('copyable-chart');
          container.appendChild(wrapper);
          const chartLine = plotted.length
            ? createChartCitationLine(plotted, context.sources, context.cards)
            : null;
          if (chartLine) container.appendChild(chartLine);
          else appendCitationLine(container, context, citedInline);
          renderChart(chart, spec);
          continue;
        }
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
      appendInlineMarkdownSafe(heading, headingMatch[2], context);
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
      appendInlineMarkdownSafe(paragraph, quoteLines.join(' '), context);
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
      const tableStart = index;
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      headerCells.forEach((cellText, cellIndex) => {
        const cell = document.createElement('th');
        if (alignments[cellIndex]) {
          cell.style.textAlign = alignments[cellIndex];
        }
        appendInlineMarkdownSafe(cell, cellText, context);
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
          appendInlineMarkdownSafe(cell, cellText, context);
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
      // Copy the source rather than the rendered table, so a table truncated
      // for display still lands on the clipboard whole.
      const tableMarkdown = sourceLines.slice(tableStart, index).join('\n');
      container.appendChild(
        wrapCopyable(table, 'Copy table', () => ({
          text: tableMarkdown,
          image: () => tableToPngBlob(table, sourceEntries)
        }))
      );
      appendCitationLine(container, context, citedInline);
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
        appendInlineMarkdownSafe(item, listLine.replace(markerPattern, ''), context);
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
    appendInlineMarkdownSafe(paragraph, paragraphLines.join(' '), context);
    container.appendChild(paragraph);
  }
}

function appendInlineMarkdownSafe(
  container: HTMLElement,
  text: string,
  context: MessageContext = EMPTY_MESSAGE_CONTEXT
) {
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
      // No target="_blank": the delegated handler forwards the click to the OS browser.
      const link = document.createElement('a');
      link.href = match[3];
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
    } else if (match[8]) {
      // A marker for a reference this turn never issued cites nothing, so it
      // stays the literal text the model wrote rather than becoming a chip.
      const citation = createInlineCitation(Number(match[8]), context.sources, context.cards);
      container.appendChild(citation ?? document.createTextNode(match[0]));
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
