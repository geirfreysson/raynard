import { Channel, invoke } from '@tauri-apps/api/core';
import {
  createElement as createLucideElement,
  Bookmark,
  BookOpen,
  Database,
  Ellipsis,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  PackageMinus,
  PanelLeftClose,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Settings,
  Share2,
  Search,
  Timer,
  Trash2,
  type IconNode
} from 'lucide';
import {
  bookmarkMessageKey,
  bookmarkPreview,
  canBookmarkMessage,
  promptForAssistant
} from './bookmarks';
import { getErrorMessage } from './errors';
import { filterChatsByName } from './chat-filter';
import { latestChatTurnIso } from './chat-history';
import {
  calendarFieldsFor,
  relativeRunLabel,
  runStatusLabel,
  scheduleSentence,
  scheduleShorthand,
  taskStatus,
  type RunTone
} from './scheduled-task-view';
import {
  applyAppUpdateState,
  renderSettingsView,
  updateNeedsAttention,
  type AppUpdateState
} from './settings-view';
import { createCoalescedSaveQueue } from './chat-persistence';
import type { ExtensionRecommendation } from './extension-recommendation';
import {
  catalogExtensionMatches,
  extensionRemovalAction,
  groupExtensions
} from './extension-groups';
import { shouldShowExtensionOnboarding } from './extension-launch';
import { validateExtensionRename } from './extension-rename';
import {
  extensionDetailSectionOrder,
  extensionKeyAction,
  extensionKeyHint,
  extensionKeyStatus,
  extensionManifestMetadata,
  extensionSourceLabel,
  extensionToolParameters,
  extensionToolSummary,
  type ExtensionDetailSection
} from './extension-detail-view';
import {
  extensionInstallActionLabel,
  shortExtensionDescription,
  toggleExtensionSelection
} from './extension-onboarding';
import { attachExternalLinkHandler } from './external-links';
import { agentActivityLabel } from './agent-activity';
import { parseChartSpec, type ChartSpec } from './chart-spec';
import { normalizeChartFenceBoundaries } from './chart-markdown';
import { renderChart, unmountChart } from './chart-mount';
import { extractPresentedChart, normalizeStoredCharts } from './presented-chart';
import { wrapCopyable } from './copy-affordance';
import { writeClipboard } from './clipboard';
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
  steerAgentTurn,
  type AgentBuildRequest,
  type AgentErrorEvent,
  type AgentRetryEvent,
  type ChatMessage,
  type PluginBuilderRequest,
  type SteerDelivery,
  type ScheduledTaskRequest,
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
  isToolSummaryActivity,
  planBuilderTimeline,
  projectBuilderTimeline,
  type BuilderActivity,
  type BuilderOutputActivity,
  type BuilderReasoningActivity,
  type BuilderStatusActivity,
  type BuilderTimelineSlot,
  type BuilderToolActivity,
  type BuilderToolEvent,
  type BuilderToolSummaryActivity
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
import type { ResultArtifactLoader } from './result-card/artifacts';
import { configureResultArtifactLoader, renderResultCards } from './result-card/mount';
import { decodeSharePayload } from './share/codec';
import { APP_SCHEME, SHARE_BASE_URL } from './share/config';
import { readDevShareHash, subscribeDeepLinks } from './share/deep-link';
import { messagesFromSharedPayload, recommendationForShare } from './share/import';
import { canShareMessage } from './share/share-message';
import { openShareModal } from './share/share-modal';
import type { ShareExtension, SharedAnswerPayload } from './share/types';
import { buildExampleData } from './result-card/example';
import { resultWasCached } from './result-card/cache';
import {
  contributionDefaults,
  parseContributionTags,
  type ExtensionContributionMetadata
} from './extension-contribution';
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
  /** Arrived through a share link, so the cards are a snapshot rather than live. */
  sharedImport?: boolean;
  /** Tool calls and reasoning in the order they happened. */
  builderActivities?: BuilderActivity[];
  cards?: StoredResultCard[];
  /** Native present_chart results, rendered beneath the answer text. */
  charts?: ChartSpec[];
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
  /** Available catalog extension selected for an inline Install action. */
  extensionRecommendation?: ExtensionRecommendation;
  /**
   * Token counts for the turn that produced this message. Counts only — the
   * source of the context meter and the per-chat figures in `/status`.
   */
  usage?: TurnUsage;
  /** Host-owned scheduling proposal awaiting confirmation, or the task that was created. */
  scheduledTaskRequest?: ScheduledTaskRequest;
  scheduledTaskId?: string;
  scheduledTaskName?: string;
  scheduledExecutionId?: string;
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
  unread: boolean;
};

type ChatHistoryPayload = {
  chatId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredChatMessage[];
  unread: boolean;
  activeBuildPlugin?: ActiveBuildPlugin;
};

type ChatHistoryList = {
  folder: string;
  chats: ChatHistoryRow[];
};

type StoredBookmark = {
  id: string;
  messageKey: string;
  chatId: string;
  chatName: string;
  prompt: string;
  answer: string;
  messageTimestamp: number;
  createdAt: number;
};

type BookmarkList = {
  bookmarks: StoredBookmark[];
  total: number;
};

type ScheduledTask = ScheduledTaskRequest & {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastError?: string;
  activeExecutionId?: string;
};

type ScheduledExecution = {
  executionId: string;
  manual: boolean;
  scheduledFor: string;
  task: ScheduledTask;
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

type CatalogExtensionTool = {
  name: string;
  description: string;
  hasCard: boolean;
};

type CatalogExtension = {
  slug: string;
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  author: string;
  homepage: string;
  version: string;
  tools: CatalogExtensionTool[];
  requiresKey: boolean;
  installed: boolean;
};

type CatalogExtensionList = {
  folder: string;
  extensions: CatalogExtension[];
};

type CatalogExtensionDetail = {
  extension: CatalogExtension;
  detail: GeneratedPluginDetail;
};

type PluginCacheSettings = {
  enabled: boolean;
  ttlHours: number;
};

type PreparedExtensionContribution = {
  folder: string;
  extensionFolder: string;
  patchPath: string;
  promptPath: string;
  prBodyPath: string;
  title: string;
  harnessPrompt: string;
  prBody: string;
  files: string[];
  checks: string[];
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
type SidebarView = 'chats' | 'plugins' | 'bookmarks' | 'scheduled';

// The plugin a Build-mode chat is actively editing. Once set, later Build-mode
// messages route straight to the coding agent for this plugin.
type ActiveBuildPlugin = { dir: string; name: string };

type ChatMeta = Pick<
  ChatHistoryPayload,
  'chatId' | 'name' | 'createdAt' | 'updatedAt' | 'unread'
> & {
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
// A real comparison table (e.g. several stocks x price/valuation/margin
// columns) routinely runs past a dozen columns. The cap only exists to stop
// pathological input from rendering an unusably wide table; 8 was low enough
// that a well-formed table fell back to raw, unparsed pipe text instead of an
// HTML table.
const MAX_MARKDOWN_TABLE_COLUMNS = 24;
const DEFAULT_SPLASH_PROMPTS = [
  'Start a lightweight research conversation',
  'Summarize what this barebones app can do',
  'Say hello and show the conversation view'
] as const;
const appIcons: Record<string, IconNode> = {
  bookmark: Bookmark,
  stopwatch: Timer,
  'book-open': BookOpen,
  database: Database,
  ellipsis: Ellipsis,
  'git-pull-request': GitPullRequest,
  key: KeyRound,
  'message-square': MessageSquare,
  'package-minus': PackageMinus,
  plus: Plus,
  'panel-left-close': PanelLeftClose,
  pause: Pause,
  pencil: Pencil,
  play: Play,
  plug: Plug,
  settings: Settings,
  'share-2': Share2,
  search: Search,
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
      <button id="bookmarksToggle" class="sidebar-rail-btn" type="button" aria-label="Bookmarks" aria-pressed="false">
        ${iconSvg('bookmark')}
      </button>
      <button id="scheduledToggle" class="sidebar-rail-btn" type="button" aria-label="Scheduled tasks" aria-pressed="false">
        ${iconSvg('stopwatch')}
      </button>
      <button id="newChatRail" class="sidebar-rail-btn" type="button" aria-label="New chat">
        ${iconSvg('plus')}
      </button>
      <button id="settingsToggle" class="sidebar-rail-btn sidebar-rail-settings" type="button" aria-label="Settings" aria-pressed="false">
        ${iconSvg('settings')}
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
      <label id="chatSearchField" class="chat-search-field">
        ${iconSvg('search')}
        <input id="chatSearchInput" type="search" aria-label="Search chats" placeholder="Search chats" autocomplete="off" maxlength="100">
      </label>
      <nav id="chatHistoryList" class="chat-history-list" aria-label="Chat history"></nav>
      <nav id="pluginList" class="chat-history-list is-hidden" aria-label="Generated plugins"></nav>
      <nav id="bookmarkList" class="chat-history-list bookmark-list is-hidden" aria-label="Bookmarks"></nav>
      <nav id="scheduledTaskList" class="chat-history-list scheduled-task-list is-hidden" aria-label="Scheduled tasks"></nav>
      <p id="chatHistoryStatus" class="chat-history-status" aria-live="polite"></p>
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

      <div id="pendingQueue" class="pending-queue is-hidden" aria-live="polite"></div>

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

      <section id="extensionsModal" class="models-modal-overlay is-hidden" aria-hidden="true">
        <div class="models-modal extensions-modal" role="dialog" aria-modal="true" aria-labelledby="extensionsModalTitle">
          <header class="models-modal-header">
            <div>
              <h2 id="extensionsModalTitle">Extensions</h2>
              <p id="extensionsModalHint">Installed and bundled extensions.</p>
            </div>
            <button id="extensionsModalClose" type="button" aria-label="Close extensions">x</button>
          </header>
          <div id="extensionsModalContent" class="models-modal-content extensions-modal-content"></div>
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

      <section id="extensionRenameModal" class="extension-delete-modal-overlay is-hidden" aria-hidden="true">
        <form id="extensionRenameForm" class="extension-delete-modal extension-rename-modal" role="dialog" aria-modal="true" aria-labelledby="extensionRenameTitle">
          <header class="extension-delete-header">
            <h2 id="extensionRenameTitle">Rename Extension</h2>
            <p>Changes the name shown in the sidebar. The folder and tool names stay as they are.</p>
          </header>
          <label class="extension-rename-field">
            <span>Name</span>
            <input id="extensionRenameInput" maxlength="64" autocomplete="off" spellcheck="false" required>
          </label>
          <p id="extensionRenameStatus" class="extension-rename-status" aria-live="polite"></p>
          <div class="extension-delete-actions">
            <button id="extensionRenameCancel" class="extension-delete-secondary" type="button">Cancel</button>
            <button id="extensionRenameSave" class="extension-rename-primary" type="submit">Save</button>
          </div>
        </form>
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

      <section id="extensionContributionModal" class="extension-contribution-modal-overlay is-hidden" aria-hidden="true">
        <form id="extensionContributionForm" class="extension-contribution-modal" role="dialog" aria-modal="true" aria-labelledby="extensionContributionTitle">
          <header class="extension-contribution-header">
            <h2 id="extensionContributionTitle">Prepare contribution</h2>
            <p>Validate this extension and prepare a pull-request bundle. Raynard does not need your GitHub credentials.</p>
          </header>
          <div class="extension-contribution-fields">
            <label><span>Category</span><input id="extensionContributionCategory" required maxlength="80"></label>
            <label><span>Tags <small>comma-separated</small></span><input id="extensionContributionTags" required maxlength="300"></label>
            <label><span>Icon <small>Lucide name</small></span><input id="extensionContributionIcon" required maxlength="64"></label>
            <label><span>Author</span><input id="extensionContributionAuthor" required maxlength="120" autocomplete="name"></label>
            <label class="is-wide"><span>Homepage</span><input id="extensionContributionHomepage" type="url" required maxlength="500" placeholder="https://…"></label>
          </div>
          <p class="extension-contribution-note">Only authored source, manifest, README, and test files are copied. Credentials, <code>.env</code>, <code>.runtime-tools.json</code>, caches, dependencies, and local data are excluded.</p>
          <p id="extensionContributionStatus" class="extension-contribution-status" aria-live="polite"></p>
          <section id="extensionContributionResult" class="extension-contribution-result is-hidden" aria-live="polite"></section>
          <div class="extension-contribution-actions">
            <button id="extensionContributionCancel" class="extension-delete-secondary" type="button">Cancel</button>
            <button id="extensionContributionPrepare" class="extension-contribution-primary" type="submit">Prepare bundle</button>
            <button id="extensionContributionCopy" class="is-hidden" type="button">Copy harness prompt</button>
            <button id="extensionContributionReveal" class="is-hidden" type="button">Show folder</button>
          </div>
        </form>
      </section>
    </section>
  </main>
`;

const shell = document.querySelector<HTMLElement>('.app-shell');
const chatsToggle = document.querySelector<HTMLButtonElement>('#chatsToggle');
const pluginsToggle = document.querySelector<HTMLButtonElement>('#pluginsToggle');
const bookmarksToggle = document.querySelector<HTMLButtonElement>('#bookmarksToggle');
const scheduledToggle = document.querySelector<HTMLButtonElement>('#scheduledToggle');
const settingsToggle = document.querySelector<HTMLButtonElement>('#settingsToggle');
const newChatRail = document.querySelector<HTMLButtonElement>('#newChatRail');
const chatSidebar = document.querySelector<HTMLElement>('#chatSidebar');
const sidebarClose = document.querySelector<HTMLButtonElement>('#sidebarClose');
const newChatButton = document.querySelector<HTMLButtonElement>('#newChatButton');
const chatSearchField = document.querySelector<HTMLElement>('#chatSearchField');
const chatSearchInput = document.querySelector<HTMLInputElement>('#chatSearchInput');
const chatHistoryList = document.querySelector<HTMLElement>('#chatHistoryList');
const pluginList = document.querySelector<HTMLElement>('#pluginList');
const bookmarkList = document.querySelector<HTMLElement>('#bookmarkList');
const scheduledTaskList = document.querySelector<HTMLElement>('#scheduledTaskList');
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
const pendingQueue = document.querySelector<HTMLElement>('#pendingQueue');
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
const onboardingPanel = document.querySelector<HTMLElement>('.onboarding-panel');
const onboardingTitle = document.querySelector<HTMLElement>('#onboardingTitle');
const onboardingHint = document.querySelector<HTMLElement>('#onboardingHint');
const onboardingContent = document.querySelector<HTMLElement>('#onboardingContent');
const modelsModalClose = document.querySelector<HTMLButtonElement>('#modelsModalClose');
const extensionsModal = document.querySelector<HTMLElement>('#extensionsModal');
const extensionsModalHint = document.querySelector<HTMLElement>('#extensionsModalHint');
const extensionsModalContent = document.querySelector<HTMLElement>('#extensionsModalContent');
const extensionsModalClose = document.querySelector<HTMLButtonElement>('#extensionsModalClose');
const extensionDeleteModal = document.querySelector<HTMLElement>('#extensionDeleteModal');
const extensionDeleteTitle = document.querySelector<HTMLElement>('#extensionDeleteTitle');
const extensionDeleteText = document.querySelector<HTMLElement>('#extensionDeleteText');
const extensionDeleteCancel = document.querySelector<HTMLButtonElement>('#extensionDeleteCancel');
const extensionDeleteConfirm = document.querySelector<HTMLButtonElement>('#extensionDeleteConfirm');
const extensionRenameModal = document.querySelector<HTMLElement>('#extensionRenameModal');
const extensionRenameForm = document.querySelector<HTMLFormElement>('#extensionRenameForm');
const extensionRenameInput = document.querySelector<HTMLInputElement>('#extensionRenameInput');
const extensionRenameStatus = document.querySelector<HTMLElement>('#extensionRenameStatus');
const extensionRenameCancel = document.querySelector<HTMLButtonElement>('#extensionRenameCancel');
const extensionRenameSave = document.querySelector<HTMLButtonElement>('#extensionRenameSave');
const pluginCacheModal = document.querySelector<HTMLElement>('#pluginCacheModal');
const pluginCacheTitle = document.querySelector<HTMLElement>('#pluginCacheTitle');
const pluginCacheHint = document.querySelector<HTMLElement>('#pluginCacheHint');
const pluginCacheEnabled = document.querySelector<HTMLInputElement>('#pluginCacheEnabled');
const pluginCacheTtl = document.querySelector<HTMLInputElement>('#pluginCacheTtl');
const pluginCacheStatus = document.querySelector<HTMLElement>('#pluginCacheStatus');
const pluginCacheClear = document.querySelector<HTMLButtonElement>('#pluginCacheClear');
const pluginCacheCancel = document.querySelector<HTMLButtonElement>('#pluginCacheCancel');
const pluginCacheSave = document.querySelector<HTMLButtonElement>('#pluginCacheSave');
const extensionContributionModal = document.querySelector<HTMLElement>('#extensionContributionModal');
const extensionContributionForm = document.querySelector<HTMLFormElement>('#extensionContributionForm');
const extensionContributionTitle = document.querySelector<HTMLElement>('#extensionContributionTitle');
const extensionContributionCategory = document.querySelector<HTMLInputElement>('#extensionContributionCategory');
const extensionContributionTags = document.querySelector<HTMLInputElement>('#extensionContributionTags');
const extensionContributionIcon = document.querySelector<HTMLInputElement>('#extensionContributionIcon');
const extensionContributionAuthor = document.querySelector<HTMLInputElement>('#extensionContributionAuthor');
const extensionContributionHomepage = document.querySelector<HTMLInputElement>('#extensionContributionHomepage');
const extensionContributionStatus = document.querySelector<HTMLElement>('#extensionContributionStatus');
const extensionContributionResult = document.querySelector<HTMLElement>('#extensionContributionResult');
const extensionContributionCancel = document.querySelector<HTMLButtonElement>('#extensionContributionCancel');
const extensionContributionPrepare = document.querySelector<HTMLButtonElement>('#extensionContributionPrepare');
const extensionContributionCopy = document.querySelector<HTMLButtonElement>('#extensionContributionCopy');
const extensionContributionReveal = document.querySelector<HTMLButtonElement>('#extensionContributionReveal');

let activeSessionId = createSessionId();
let activeChatMeta = createChatMeta(activeSessionId);
let chatMessages: ChatMessage[] = [];
let storedMessages: StoredChatMessage[] = [];
let chatHistoryRows: ChatHistoryRow[] = [];
let generatedPlugins: GeneratedPlugin[] = [];
let catalogExtensions: CatalogExtension[] = [];
let bookmarkRows: StoredBookmark[] = [];
let bookmarkTotal = 0;
let bookmarkLoading = false;
let bookmarkRefreshQueued = false;
let scheduledTasks: ScheduledTask[] = [];
let activeScheduledTaskId: string | null = null;
let scheduledTaskRunnerActive = false;
const scheduledTaskQueue: Array<{ taskId: string; manual: boolean }> = [];
let activeBookmarks = new Map<string, StoredBookmark>();
let selectedPluginId = '';
let selectedCatalogExtensionSlug = '';
let sidebarView: SidebarView = 'chats';
const BOOKMARK_PAGE_SIZE = 50;
const chatRuns = new ChatRunRegistry<ChatMeta, StoredChatMessage>();
const renderedMessageArticles = new WeakMap<StoredChatMessage, HTMLElement>();
const chatSnapshotSaves = createCoalescedSaveQueue<ChatHistoryPayload, ChatHistoryRow>((payload) =>
  invoke<ChatHistoryRow>('save_chat_history', { payload })
);
/** Reads card data that was too large to inline into chat history. Shared with
 *  the share sheet, which must re-inline that data before a card can travel. */
const resultArtifactLoader: ResultArtifactLoader = (artifact) =>
  invoke('read_result_artifact', {
    chatId: artifact.chatId,
    artifactId: artifact.artifactId
  });
configureResultArtifactLoader(resultArtifactLoader);
let appMode: AppMode = loadAppMode();
let modelProviders: ModelProvider[] = [];
let llmEnvStatus: LlmEnvStatus | null = null;
let mainViewRevision = 0;
let initialExtensionsLoaded = false;
let extensionOnboardingPending = true;
let awaitingExtensionCatalogAfterProvider = false;
let selectedOnboardingExtensionSlugs = new Set<string>();
let pendingExtensionDelete:
  | {
      resolve: (confirmed: boolean) => void;
    }
  | null = null;
let activeExtensionRename: GeneratedPlugin | null = null;
let activePluginCache: { pluginId: string; label: string } | null = null;
let activeExtensionContribution:
  | { detail: GeneratedPluginDetail; prepared?: PreparedExtensionContribution }
  | null = null;

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
void refreshScheduledTasks();
syncModeControls();

// Shared answers. The subscription drains anything the OS delivered before the
// webview existed, so a cold-start deep link is not lost. The hash is the dev
// path: macOS cannot register a URL scheme at runtime, so `tauri dev` never
// receives a real deep link.
void subscribeDeepLinks(APP_SCHEME, (encoded) => void openSharedAnswer(encoded)).catch(() => {
  // An older host without the command simply has no share-link import.
});
const devShare = readDevShareHash(window.location.hash);
if (devShare) void openSharedAnswer(devShare);

watchAppUpdates();

const scheduledWakeChannel = new Channel<number>(() => void enqueueDueScheduledTasks());
void invoke('subscribe_scheduled_tasks', { onWake: scheduledWakeChannel }).catch(() => {
  // An older host has no scheduler. The sidebar commands will surface that
  // mismatch if the user opens it.
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
      closeExtensionsModal();
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const target = event.currentTarget;
    if (target instanceof HTMLTextAreaElement) {
      // Alt+Enter queues behind the whole answer instead of interrupting it.
      void submitMessage(target, event.altKey ? 'followUp' : 'steer');
    }
  });
}

modelsModalClose?.addEventListener('click', () => closeModelsModal());
modelsModal?.addEventListener('click', (event) => {
  if (event.target === modelsModal) {
    closeModelsModal();
  }
});
extensionsModalClose?.addEventListener('click', closeExtensionsModal);
extensionsModal?.addEventListener('click', (event) => {
  if (event.target === extensionsModal) closeExtensionsModal();
});
extensionDeleteCancel?.addEventListener('click', () => resolveExtensionDelete(false));
extensionDeleteConfirm?.addEventListener('click', () => resolveExtensionDelete(true));
extensionDeleteModal?.addEventListener('click', (event) => {
  if (event.target === extensionDeleteModal) {
    resolveExtensionDelete(false);
  }
});
extensionRenameCancel?.addEventListener('click', closeExtensionRenameModal);
extensionRenameInput?.addEventListener('input', syncExtensionRenameState);
extensionRenameForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveExtensionRename();
});
extensionRenameModal?.addEventListener('click', (event) => {
  if (event.target === extensionRenameModal) closeExtensionRenameModal();
});
pluginCacheCancel?.addEventListener('click', closePluginCacheModal);
pluginCacheSave?.addEventListener('click', () => void saveActivePluginCacheSettings());
pluginCacheClear?.addEventListener('click', () => void clearActivePluginCache());
pluginCacheEnabled?.addEventListener('change', syncPluginCacheDurationState);
pluginCacheModal?.addEventListener('click', (event) => {
  if (event.target === pluginCacheModal) closePluginCacheModal();
});
extensionContributionCancel?.addEventListener('click', closeExtensionContributionModal);
extensionContributionForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  void prepareActiveExtensionContribution();
});
extensionContributionCopy?.addEventListener('click', () => void copyExtensionContributionPrompt());
extensionContributionReveal?.addEventListener('click', () => void revealExtensionContribution());
extensionContributionModal?.addEventListener('click', (event) => {
  if (event.target === extensionContributionModal) closeExtensionContributionModal();
});
document.addEventListener('click', (event) => {
  const target = event.target;
  if (target instanceof Element && !target.closest('.plugin-detail-actions')) {
    closePluginDetailMenu();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeExtensionsModal();
  closePluginDetailMenu();
  if (activePluginCache) closePluginCacheModal();
  if (activeExtensionRename) closeExtensionRenameModal();
  if (activeExtensionContribution) closeExtensionContributionModal();
  if (pendingExtensionDelete) resolveExtensionDelete(false);
});
window.addEventListener('focus', () => {
  const active = chatHistoryRows.find((chat) => chat.chatId === activeSessionId);
  if (active?.unread) void markChatRead(active.chatId);
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
bookmarksToggle?.addEventListener('click', () => {
  if (sidebarView !== 'bookmarks') {
    setSidebarView('bookmarks');
    void refreshBookmarks(true);
    return;
  }
  setSidebarOpen(!shell?.classList.contains('sidebar-open'));
});
settingsToggle?.addEventListener('click', () => {
  void openSettingsPage();
});

scheduledToggle?.addEventListener('click', () => {
  if (sidebarView !== 'scheduled') {
    setSidebarView('scheduled');
    void refreshScheduledTasks();
    return;
  }
  setSidebarOpen(!shell?.classList.contains('sidebar-open'));
});

sidebarClose?.addEventListener('click', () => setSidebarOpen(false));
chatSearchInput?.addEventListener('input', () => {
  renderChatHistory();
});
newChatButton?.addEventListener('click', () => {
  setSidebarView('chats');
  void startNewConversation({ showPreChat: true });
});
newChatRail?.addEventListener('click', () => {
  setSidebarView('chats');
  void startNewConversation({ showPreChat: true });
});
stopStreamButton?.addEventListener('click', () => {
  const run = chatRuns.get(activeSessionId);
  if (!run?.streamId) return;
  stopStreamButton.disabled = true;
  stopStreamButton.textContent = 'Stopping';
  // The sidecar dies with its queue, so anything it never took goes back to the
  // composer.
  restoreQueuedToComposer(run);
  void cancelAgentTurnStream(run.streamId);
});

async function loadEnvStatus() {
  const status = await invoke<LlmEnvStatus>('load_llm_env_status');
  llmEnvStatus = status;
  renderComposerModelLabel();
  if (status.configured) void enqueueDueScheduledTasks();
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
  if (command === '/extensions') {
    await openExtensionsCommandFlow(input);
    return true;
  }
  if (command === '/models') {
    await openModelsCommandFlow(input);
    return true;
  }
  if (command === '/status') {
    await openStatusCommandFlow(input);
    return true;
  }
  if (command === '/settings') {
    if (input) input.value = '';
    hideSlashMenu();
    await openSettingsPage();
    return true;
  }
  if (command === '/new') {
    if (input) input.value = '';
    hideSlashMenu();
    setSidebarView('chats');
    await startNewConversation({ showPreChat: true });
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

async function openExtensionsCommandFlow(input: HTMLTextAreaElement | null) {
  if (input) input.value = '';
  hideSlashMenu();
  closeModelsModal();
  extensionsModal?.classList.remove('is-hidden');
  extensionsModal?.setAttribute('aria-hidden', 'false');
  if (extensionsModalHint) extensionsModalHint.textContent = 'Loading extensions...';
  if (extensionsModalContent) {
    extensionsModalContent.innerHTML = '<p class="models-modal-empty">Loading...</p>';
  }
  await loadExtensionsModal();
}

function closeExtensionsModal() {
  extensionsModal?.classList.add('is-hidden');
  extensionsModal?.setAttribute('aria-hidden', 'true');
}

async function loadExtensionsModal() {
  try {
    const [installed, catalog] = await Promise.all([
      invoke<GeneratedPluginList>('list_generated_plugins'),
      invoke<CatalogExtensionList>('list_catalog_extensions')
    ]);
    generatedPlugins = installed.plugins;
    catalogExtensions = catalog.extensions;
    renderSplashPrompts();
    renderGeneratedPlugins();
    renderExtensionsModal();
  } catch (error) {
    if (extensionsModalHint) {
      extensionsModalHint.textContent = getErrorMessage(error, 'Could not load extensions.');
    }
    if (extensionsModalContent) extensionsModalContent.innerHTML = '';
  }
}

function renderExtensionsModal() {
  if (!extensionsModalContent) return;
  const groups = groupExtensions(generatedPlugins, catalogExtensions);
  if (extensionsModalHint) {
    extensionsModalHint.textContent = `${groups.yourExtensions.length} yours · ${groups.installed.length} installed · ${groups.available.length} available`;
  }
  extensionsModalContent.innerHTML = '';

  const yourSection = document.createElement('section');
  yourSection.className = 'extensions-section';
  const yourTitle = document.createElement('h3');
  yourTitle.textContent = 'Your extensions';
  yourSection.appendChild(yourTitle);
  if (!groups.yourExtensions.length) {
    const empty = document.createElement('p');
    empty.className = 'extensions-empty';
    empty.textContent = 'You have not coded any local extensions yet.';
    yourSection.appendChild(empty);
  } else {
    for (const plugin of groups.yourExtensions) {
      yourSection.appendChild(renderLocalExtensionRow(plugin));
    }
  }
  extensionsModalContent.appendChild(yourSection);

  const installedSection = document.createElement('section');
  installedSection.className = 'extensions-section';
  const installedTitle = document.createElement('h3');
  installedTitle.textContent = 'Installed';
  installedSection.appendChild(installedTitle);
  if (!groups.installed.length) {
    const empty = document.createElement('p');
    empty.className = 'extensions-empty';
    empty.textContent = 'No bundled extensions are installed.';
    installedSection.appendChild(empty);
  } else {
    for (const extension of groups.installed) {
      installedSection.appendChild(renderCatalogExtensionRow(extension, true));
    }
  }
  extensionsModalContent.appendChild(installedSection);

  const availableSection = document.createElement('section');
  availableSection.className = 'extensions-section';
  const availableTitle = document.createElement('h3');
  availableTitle.textContent = 'Available';
  availableSection.appendChild(availableTitle);
  if (!groups.available.length) {
    const empty = document.createElement('p');
    empty.className = 'extensions-empty';
    empty.textContent = catalogExtensions.length
      ? 'All bundled extensions are installed.'
      : 'No bundled extensions were found.';
    availableSection.appendChild(empty);
  } else {
    for (const extension of groups.available) {
      availableSection.appendChild(renderCatalogExtensionRow(extension, false));
    }
  }
  extensionsModalContent.appendChild(availableSection);
}

function renderLocalExtensionRow(plugin: GeneratedPlugin) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'extensions-installed-row';
  const icon = document.createElement('span');
  icon.className = 'extensions-row-icon';
  icon.innerHTML = iconSvg('plug');
  const copy = document.createElement('span');
  copy.className = 'extensions-row-copy';
  const heading = document.createElement('span');
  heading.className = 'extensions-row-heading';
  const name = document.createElement('strong');
  name.textContent = plugin.name;
  heading.appendChild(name);
  if (plugin.credentials.length) {
    const key = document.createElement('span');
    key.className = 'extension-key-pill';
    key.textContent = 'Key';
    heading.appendChild(key);
  }
  const meta = document.createElement('span');
  meta.textContent = `${plugin.tools.length} ${plugin.tools.length === 1 ? 'tool' : 'tools'} · ${plugin.status || 'local'}`;
  copy.append(heading, meta);
  const disclosure = document.createElement('span');
  disclosure.className = 'extensions-row-disclosure';
  disclosure.textContent = '›';
  row.append(icon, copy, disclosure);
  row.addEventListener('click', () => {
    closeExtensionsModal();
    void openGeneratedPlugin(plugin.id);
  });
  return row;
}

function renderCatalogExtensionRow(extension: CatalogExtension, installed: boolean) {
  const row = document.createElement('article');
  row.className = 'extensions-catalog-row';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'extensions-catalog-open';
  const icon = document.createElement('span');
  icon.className = 'extensions-row-icon';
  icon.innerHTML = iconSvg(extension.icon || 'plug');
  const copy = document.createElement('span');
  copy.className = 'extensions-row-copy';
  const heading = document.createElement('span');
  heading.className = 'extensions-row-heading';
  const name = document.createElement('strong');
  name.textContent = extension.name;
  heading.appendChild(name);
  if (extension.requiresKey) {
    const key = document.createElement('span');
    key.className = 'extension-key-pill';
    key.textContent = 'Key';
    heading.appendChild(key);
  }
  const description = document.createElement('span');
  description.textContent = extension.description;
  const tools = document.createElement('span');
  tools.className = 'extensions-tool-summary';
  tools.textContent = extension.tools.map((tool) => tool.name).join(' · ');
  copy.append(heading, description, tools);
  open.append(icon, copy);
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'extensions-install-button';
  action.textContent = installed ? 'Open' : 'Install';
  if (installed) {
    const plugin = generatedPlugins.find((candidate) =>
      catalogExtensionMatches(candidate, extension)
    );
    action.disabled = !plugin;
    open.disabled = !plugin;
    open.addEventListener('click', () => {
      if (!plugin) return;
      closeExtensionsModal();
      void openGeneratedPlugin(plugin.id);
    });
    action.addEventListener('click', () => {
      if (!plugin) return;
      closeExtensionsModal();
      void openGeneratedPlugin(plugin.id);
    });
  } else {
    open.addEventListener('click', () => {
      closeExtensionsModal();
      void openCatalogExtension(extension.slug);
    });
    action.addEventListener('click', () => void installCatalogExtension(extension, action));
  }
  row.append(open, action);
  return row;
}

async function installCatalogExtension(
  extension: CatalogExtension,
  button: HTMLButtonElement
) {
  button.disabled = true;
  button.textContent = 'Installing...';
  if (extensionsModalHint) extensionsModalHint.textContent = `Installing ${extension.name}...`;
  try {
    const installed = await invoke<GeneratedPlugin>('install_catalog_extension', {
      slug: extension.slug
    });
    await loadExtensionsModal();
    button.textContent = 'Installed';
    if (selectedCatalogExtensionSlug === extension.slug) {
      await openGeneratedPlugin(installed.id);
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Install';
    if (sidebarView === 'plugins' && chatHistoryStatus) {
      chatHistoryStatus.textContent = getErrorMessage(error, `Could not install ${extension.name}.`);
    }
    if (extensionsModalHint) {
      extensionsModalHint.textContent = getErrorMessage(error, `Could not install ${extension.name}.`);
    }
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

/**
 * Opens Settings in the shared detail section, the same place plugin and
 * scheduled-task screens use.
 *
 * The four update commands are handed over as thunks so `settings-view.ts`
 * never imports Tauri; `open_external_url` is only needed for the manual
 * download, since `attachExternalLinkHandler` already routes ordinary links.
 */
async function openSettingsPage() {
  if (!pluginDetailView || !messages) return;
  mainViewRevision += 1;

  let state: AppUpdateState;
  try {
    state = await invoke<AppUpdateState>('get_app_update_state');
  } catch (error) {
    console.error('Could not read the update state:', getErrorMessage(error));
    return;
  }

  activeScheduledTaskId = null;
  selectedPluginId = '';
  selectedCatalogExtensionSlug = '';
  renderGeneratedPlugins();
  renderScheduledTasks();

  pluginDetailView.replaceChildren();
  const page = document.createElement('div');
  page.className = 'settings-view';
  pluginDetailView.appendChild(page);
  renderSettingsView(
    page,
    {
      check: () => invoke<AppUpdateState>('check_for_app_update'),
      download: () => invoke<AppUpdateState>('download_app_update'),
      install: () => invoke<AppUpdateState>('install_app_update'),
      openExternal: async (url: string) => {
        await invoke('open_external_url', { url });
      }
    },
    state
  );

  shell?.classList.add('plugin-view');
  shell?.classList.remove('pre-chat');
  pluginDetailView.classList.remove('is-hidden');
  messages.classList.add('is-hidden');
  chatForm?.classList.add('is-hidden');
  document.querySelector<HTMLElement>('.intro-stage')?.classList.add('is-hidden');
  settingsToggle?.setAttribute('aria-pressed', 'true');
}

/**
 * Subscribes to update pushes for the life of the process.
 *
 * The dot on the rail is the only ambient signal this app has — there is no
 * toast surface — so a background check that finds something has to be visible
 * without stealing the screen.
 */
function watchAppUpdates() {
  const onState = new Channel<AppUpdateState>();
  onState.onmessage = (state) => {
    applyAppUpdateState(state);
    settingsToggle?.classList.toggle('has-update', updateNeedsAttention(state));
  };
  invoke<AppUpdateState>('subscribe_app_updates', { onState })
    .then((state) => {
      settingsToggle?.classList.toggle('has-update', updateNeedsAttention(state));
    })
    .catch((error) => {
      console.error('Could not subscribe to app updates:', getErrorMessage(error));
    });
}

function openModelsModal() {
  closeExtensionsModal();
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
  if (needsProviderOnboarding(modelProviders)) {
    openOnboarding();
  } else {
    maybeShowExtensionOnboarding();
  }
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
    onConnected: () => {
      if (!initialExtensionsLoaded) {
        awaitingExtensionCatalogAfterProvider = true;
        renderExtensionOnboardingLoading();
        return;
      }
      if (!maybeShowExtensionOnboarding()) closeOnboarding();
    }
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
  onboardingPanel?.classList.remove('is-extension-step');
  onboardingContent?.classList.remove('extension-onboarding-content');
  selectedOnboardingExtensionSlugs = new Set();
  introInput?.focus();
}

function renderExtensionOnboardingLoading() {
  onboardingOverlay?.classList.remove('is-hidden');
  onboardingOverlay?.setAttribute('aria-hidden', 'false');
  onboardingPanel?.classList.add('is-extension-step');
  onboardingContent?.classList.add('extension-onboarding-content');
  if (onboardingTitle) onboardingTitle.textContent = 'Loading extensions';
  if (onboardingHint) onboardingHint.textContent = 'Preparing the available data sources…';
  if (onboardingContent) {
    onboardingContent.innerHTML = '<p class="extension-onboarding-loading">Loading…</p>';
  }
}

function renderExtensionOnboarding() {
  if (!onboardingContent) return;
  selectedOnboardingExtensionSlugs = new Set();
  onboardingOverlay?.classList.remove('is-hidden');
  onboardingOverlay?.setAttribute('aria-hidden', 'false');
  onboardingPanel?.classList.add('is-extension-step');
  onboardingContent.classList.add('extension-onboarding-content');
  if (onboardingTitle) {
    onboardingTitle.textContent = 'Please select what types of data to talk to';
  }
  if (onboardingHint) {
    onboardingHint.textContent = 'Choose one or more extensions to get started.';
  }
  onboardingContent.innerHTML = '';

  const available = catalogExtensions.filter((extension) => !extension.installed);
  const grid = document.createElement('div');
  grid.className = 'extension-onboarding-grid';

  for (const extension of available) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'extension-onboarding-card';
    card.dataset.extensionSlug = extension.slug;
    card.setAttribute('aria-pressed', 'false');

    const selectedMark = document.createElement('span');
    selectedMark.className = 'extension-onboarding-selected-mark';
    selectedMark.textContent = '✓';
    selectedMark.setAttribute('aria-hidden', 'true');

    const icon = document.createElement('span');
    icon.className = 'extension-onboarding-icon';
    icon.innerHTML = iconSvg(extension.icon || 'plug');

    const name = document.createElement('strong');
    name.textContent = extension.name;

    const description = document.createElement('span');
    description.className = 'extension-onboarding-description';
    description.textContent = shortExtensionDescription(extension.description);

    card.append(selectedMark, icon, name, description);
    if (extension.requiresKey) {
      const key = document.createElement('span');
      key.className = 'extension-key-pill extension-onboarding-key-pill';
      key.textContent = 'Key';
      card.appendChild(key);
    }
    grid.appendChild(card);
  }

  if (!available.length) {
    const empty = document.createElement('p');
    empty.className = 'extension-onboarding-empty';
    empty.textContent = 'No ready-made extensions are available yet.';
    grid.appendChild(empty);
  }

  const footer = document.createElement('footer');
  footer.className = 'extension-onboarding-footer';
  const note = document.createElement('p');
  note.className = 'extension-onboarding-note';
  note.textContent = '(You can add your own with a prompt.)';

  const actions = document.createElement('div');
  actions.className = 'extension-onboarding-actions';
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'onboarding-secondary extension-onboarding-skip';
  skip.textContent = 'Skip for now';
  skip.addEventListener('click', closeOnboarding);
  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'onboarding-primary extension-onboarding-install';
  install.textContent = extensionInstallActionLabel(0);
  install.disabled = true;

  const syncSelection = () => {
    for (const tile of grid.querySelectorAll<HTMLButtonElement>('.extension-onboarding-card')) {
      const selected = selectedOnboardingExtensionSlugs.has(tile.dataset.extensionSlug || '');
      tile.classList.toggle('is-selected', selected);
      tile.setAttribute('aria-pressed', String(selected));
    }
    install.disabled = selectedOnboardingExtensionSlugs.size === 0;
    install.textContent = extensionInstallActionLabel(selectedOnboardingExtensionSlugs.size);
  };

  grid.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest<HTMLButtonElement>('.extension-onboarding-card');
    const slug = card?.dataset.extensionSlug;
    if (!slug || card.disabled) return;
    selectedOnboardingExtensionSlugs = toggleExtensionSelection(
      selectedOnboardingExtensionSlugs,
      slug
    );
    syncSelection();
  });
  install.addEventListener('click', () => {
    void installOnboardingExtensions(install, skip, grid);
  });

  actions.append(skip, install);
  footer.append(note, actions);
  onboardingContent.append(grid, footer);
}

async function installOnboardingExtensions(
  install: HTMLButtonElement,
  skip: HTMLButtonElement,
  grid: HTMLElement
) {
  const selected = catalogExtensions.filter((extension) =>
    selectedOnboardingExtensionSlugs.has(extension.slug)
  );
  if (!selected.length) return;

  install.disabled = true;
  skip.disabled = true;
  for (const card of grid.querySelectorAll<HTMLButtonElement>('.extension-onboarding-card')) {
    card.disabled = true;
  }

  try {
    for (const [index, extension] of selected.entries()) {
      if (onboardingHint) {
        onboardingHint.textContent = `Installing ${index + 1} of ${selected.length}: ${extension.name}`;
      }
      await invoke<GeneratedPlugin>('install_catalog_extension', { slug: extension.slug });
    }
    await refreshGeneratedPlugins();
    closeOnboarding();
  } catch (error) {
    const message = getErrorMessage(error, 'Could not install the selected extensions.');
    await refreshGeneratedPlugins();
    renderExtensionOnboarding();
    if (onboardingHint) onboardingHint.textContent = message;
  }
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
  onboardingPanel?.classList.remove('is-extension-step');
  onboardingContent?.classList.remove('extension-onboarding-content');
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
    updatedAt: now,
    unread: false
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
  const activeToggle =
    sidebarView === 'plugins'
      ? pluginsToggle
      : sidebarView === 'bookmarks'
        ? bookmarksToggle
        : sidebarView === 'scheduled'
          ? scheduledToggle
        : chatsToggle;
  activeToggle?.setAttribute('aria-pressed', String(open));
}

function setSidebarView(view: SidebarView) {
  sidebarView = view;
  setSidebarOpen(true);
  chatsToggle?.classList.toggle('is-active', view === 'chats');
  pluginsToggle?.classList.toggle('is-active', view === 'plugins');
  bookmarksToggle?.classList.toggle('is-active', view === 'bookmarks');
  scheduledToggle?.classList.toggle('is-active', view === 'scheduled');
  chatsToggle?.setAttribute('aria-pressed', String(view === 'chats'));
  pluginsToggle?.setAttribute('aria-pressed', String(view === 'plugins'));
  bookmarksToggle?.setAttribute('aria-pressed', String(view === 'bookmarks'));
  scheduledToggle?.setAttribute('aria-pressed', String(view === 'scheduled'));
  if (chatHistoryList) chatHistoryList.classList.toggle('is-hidden', view !== 'chats');
  if (pluginList) pluginList.classList.toggle('is-hidden', view !== 'plugins');
  if (bookmarkList) bookmarkList.classList.toggle('is-hidden', view !== 'bookmarks');
  if (scheduledTaskList) scheduledTaskList.classList.toggle('is-hidden', view !== 'scheduled');
  const title = chatSidebar?.querySelector('h2');
  if (title) {
    title.textContent =
      view === 'plugins'
        ? 'Extensions'
        : view === 'bookmarks'
          ? 'Bookmarks'
          : view === 'scheduled'
            ? 'Scheduled tasks'
            : 'Chats';
  }
  newChatButton?.classList.toggle('is-hidden', view !== 'chats');
  chatSearchField?.classList.toggle('is-hidden', view !== 'chats');
  if (chatHistoryStatus) {
    chatHistoryStatus.textContent = sidebarStatusText(view);
  }
}

function sidebarStatusText(view: SidebarView) {
  if (view === 'plugins') return '';
  if (view === 'bookmarks') {
    if (bookmarkLoading && !bookmarkRows.length) return 'Loading bookmarks…';
    return bookmarkTotal ? '' : 'No bookmarks yet.';
  }
  if (view === 'scheduled') return scheduledTasks.length ? '' : 'No scheduled tasks yet.';
  if (!chatHistoryRows.length) return 'No saved chats yet.';
  const query = chatSearchInput?.value.trim() ?? '';
  return query && !filterChatsByName(chatHistoryRows, query).length
    ? `No chats match “${query}”.`
    : '';
}

async function refreshGeneratedPlugins() {
  try {
    const [result, catalog] = await Promise.all([
      invoke<GeneratedPluginList>('list_generated_plugins'),
      invoke<CatalogExtensionList>('list_catalog_extensions')
    ]);
    generatedPlugins = result.plugins;
    catalogExtensions = catalog.extensions;
    initialExtensionsLoaded = true;
    renderSplashPrompts();
    renderGeneratedPlugins();
    const extensionOnboardingShown = maybeShowExtensionOnboarding();
    if (awaitingExtensionCatalogAfterProvider) {
      awaitingExtensionCatalogAfterProvider = false;
      if (!extensionOnboardingShown) closeOnboarding();
    }
    if (sidebarView === 'plugins' && chatHistoryStatus) {
      chatHistoryStatus.textContent = '';
    }
  } catch (error) {
    if (awaitingExtensionCatalogAfterProvider) {
      awaitingExtensionCatalogAfterProvider = false;
      extensionOnboardingPending = false;
      closeOnboarding();
    }
    if (sidebarView === 'plugins' && chatHistoryStatus) {
      chatHistoryStatus.textContent = getErrorMessage(error, 'Could not load plugins.');
    }
  }
}

function maybeShowExtensionOnboarding(): boolean {
  const providerConnected = !needsProviderOnboarding(modelProviders);
  if (!extensionOnboardingPending || !initialExtensionsLoaded || !providerConnected) {
    return false;
  }
  extensionOnboardingPending = false;
  if (shouldShowExtensionOnboarding(providerConnected, generatedPlugins, catalogExtensions)) {
    renderExtensionOnboarding();
    return true;
  }
  return false;
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
  const groups = groupExtensions(generatedPlugins, catalogExtensions);

  appendPluginSidebarGroup('Your extensions', groups.yourExtensions, 'No local extensions yet.');

  const installedPlugins = groups.installed
    .map((extension) =>
      generatedPlugins.find((plugin) => catalogExtensionMatches(plugin, extension))
    )
    .filter((plugin): plugin is GeneratedPlugin => Boolean(plugin));
  appendPluginSidebarGroup('Installed', installedPlugins, 'No catalog extensions installed.');

  const availableLabel = document.createElement('h3');
  availableLabel.className = 'plugin-list-group-label';
  availableLabel.textContent = 'Available';
  pluginList.appendChild(availableLabel);
  if (!groups.available.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-list-empty';
    empty.textContent = catalogExtensions.length
      ? 'All catalog extensions are installed.'
      : 'No catalog extensions available.';
    pluginList.appendChild(empty);
  } else {
    for (const extension of groups.available) {
      pluginList.appendChild(renderAvailablePluginSidebarRow(extension));
    }
  }
}

function appendPluginSidebarGroup(
  label: string,
  plugins: GeneratedPlugin[],
  emptyCopy: string
) {
  if (!pluginList) return;
  const heading = document.createElement('h3');
  heading.className = 'plugin-list-group-label';
  heading.textContent = label;
  pluginList.appendChild(heading);
  if (!plugins.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-list-empty';
    empty.textContent = emptyCopy;
    pluginList.appendChild(empty);
    return;
  }
  for (const plugin of plugins) pluginList.appendChild(renderPluginSidebarRow(plugin));
}

function renderPluginSidebarRow(plugin: GeneratedPlugin) {
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

  const removalAction = extensionRemovalAction(plugin, catalogExtensions);
  const removalLabel = removalAction === 'uninstall' ? 'Uninstall' : 'Delete';
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'chat-history-delete';
  removeButton.setAttribute('aria-label', `${removalLabel} ${plugin.name}`);
  removeButton.title = `${removalLabel} ${plugin.name}`;
  removeButton.innerHTML = iconSvg(removalAction === 'uninstall' ? 'package-minus' : 'trash-2');
  removeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void removeGeneratedPlugin(plugin.id);
  });
  row.appendChild(removeButton);
  return row;
}

function renderAvailablePluginSidebarRow(extension: CatalogExtension) {
  const row = document.createElement('div');
  row.className = `chat-history-row plugin-catalog-available-row${
    extension.slug === selectedCatalogExtensionSlug ? ' is-active' : ''
  }`;
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'chat-history-open plugin-catalog-summary';
  const title = document.createElement('span');
  title.className = 'chat-history-title';
  title.textContent = extension.name;
  const meta = document.createElement('span');
  meta.className = 'chat-history-meta';
  meta.textContent = `${extension.category} · ${extension.tools.length} ${extension.tools.length === 1 ? 'tool' : 'tools'}`;
  summary.append(title, meta);
  summary.addEventListener('click', () => void openCatalogExtension(extension.slug));
  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'plugin-sidebar-install';
  install.textContent = 'Install';
  install.addEventListener('click', () => void installCatalogExtension(extension, install));
  row.append(summary, install);
  return row;
}

async function openGeneratedPlugin(pluginId: string) {
  if (!pluginDetailView || !messages) return;
  const viewRevision = ++mainViewRevision;
  const detail = await invoke<GeneratedPluginDetail>('read_generated_plugin', { pluginId });
  if (viewRevision !== mainViewRevision) return;
  selectedPluginId = detail.plugin.id;
  selectedCatalogExtensionSlug = '';
  renderGeneratedPlugins();
  renderPluginDetail(detail);
  shell?.classList.add('plugin-view');
  shell?.classList.remove('pre-chat');
  pluginDetailView.classList.remove('is-hidden');
  messages.classList.add('is-hidden');
  chatForm?.classList.add('is-hidden');
  document.querySelector<HTMLElement>('.intro-stage')?.classList.add('is-hidden');
}

async function openCatalogExtension(slug: string) {
  if (!pluginDetailView || !messages) return;
  const viewRevision = ++mainViewRevision;
  const result = await invoke<CatalogExtensionDetail>('read_catalog_extension', { slug });
  if (viewRevision !== mainViewRevision) return;
  selectedPluginId = '';
  selectedCatalogExtensionSlug = result.extension.slug;
  renderGeneratedPlugins();
  renderPluginDetail(result.detail, { availableExtension: result.extension });
  shell?.classList.add('plugin-view');
  shell?.classList.remove('pre-chat');
  pluginDetailView.classList.remove('is-hidden');
  messages.classList.add('is-hidden');
  chatForm?.classList.add('is-hidden');
  document.querySelector<HTMLElement>('.intro-stage')?.classList.add('is-hidden');
}

async function removeGeneratedPlugin(pluginId: string) {
  const plugin = generatedPlugins.find((item) => item.id === pluginId);
  const label = plugin?.name || pluginId;
  const removalAction = plugin
    ? extensionRemovalAction(plugin, catalogExtensions)
    : 'delete';
  const confirmed = await confirmExtensionRemoval(label, removalAction);
  if (!confirmed) {
    return;
  }

  await invoke('delete_generated_plugin', { pluginId });
  if (selectedPluginId === pluginId) {
    selectedPluginId = '';
    pluginDetailView?.classList.add('is-hidden');
    settingsToggle?.setAttribute('aria-pressed', 'false');
    messages?.classList.remove('is-hidden');
    chatForm?.classList.remove('is-hidden');
    shell?.classList.remove('plugin-view');
  }
  await refreshGeneratedPlugins();
}

function confirmExtensionRemoval(label: string, removalAction: 'delete' | 'uninstall') {
  const uninstalling = removalAction === 'uninstall';
  const actionLabel = uninstalling ? 'Uninstall' : 'Delete';
  const description = uninstalling
    ? `Uninstall "${label}"? This removes the installed copy. You can install it again from Available.`
    : `Delete "${label}"? This removes the locally authored extension files and cannot be undone.`;
  if (!extensionDeleteModal || !extensionDeleteText || !extensionDeleteConfirm) {
    return Promise.resolve(window.confirm(description));
  }

  if (pendingExtensionDelete) {
    pendingExtensionDelete.resolve(false);
  }

  if (extensionDeleteTitle) extensionDeleteTitle.textContent = `${actionLabel} Extension`;
  extensionDeleteText.textContent = description;
  extensionDeleteConfirm.textContent = actionLabel;
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

function openExtensionRenameModal(plugin: GeneratedPlugin) {
  if (!extensionRenameModal || !extensionRenameInput || !extensionRenameSave) return;
  activeExtensionRename = plugin;
  extensionRenameInput.value = plugin.name;
  extensionRenameSave.disabled = true;
  if (extensionRenameStatus) extensionRenameStatus.textContent = '';
  extensionRenameModal.classList.remove('is-hidden');
  extensionRenameModal.setAttribute('aria-hidden', 'false');
  extensionRenameInput.focus();
  extensionRenameInput.select();
}

function closeExtensionRenameModal() {
  activeExtensionRename = null;
  extensionRenameModal?.classList.add('is-hidden');
  extensionRenameModal?.setAttribute('aria-hidden', 'true');
}

/** Validates as the user types so Save is only live for a name that can land. */
function syncExtensionRenameState() {
  if (!activeExtensionRename || !extensionRenameInput || !extensionRenameSave) return;
  const result = validateExtensionRename(
    extensionRenameInput.value,
    activeExtensionRename,
    generatedPlugins
  );
  extensionRenameSave.disabled = !result.ok || !result.changed;
  if (extensionRenameStatus) {
    extensionRenameStatus.textContent = result.ok ? '' : result.error;
  }
}

async function saveExtensionRename() {
  const plugin = activeExtensionRename;
  if (!plugin || !extensionRenameInput || !extensionRenameSave) return;
  const result = validateExtensionRename(extensionRenameInput.value, plugin, generatedPlugins);
  if (!result.ok) {
    if (extensionRenameStatus) extensionRenameStatus.textContent = result.error;
    return;
  }
  if (!result.changed) {
    closeExtensionRenameModal();
    return;
  }

  extensionRenameSave.disabled = true;
  if (extensionRenameStatus) extensionRenameStatus.textContent = 'Renaming…';
  try {
    const detail = await invoke<GeneratedPluginDetail>('rename_generated_plugin', {
      pluginId: plugin.id,
      name: result.name
    });
    closeExtensionRenameModal();
    await refreshGeneratedPlugins();
    if (selectedPluginId === detail.plugin.id) renderPluginDetail(detail);
  } catch (error) {
    extensionRenameSave.disabled = false;
    if (extensionRenameStatus) {
      extensionRenameStatus.textContent = getErrorMessage(
        error,
        `Could not rename ${plugin.name}.`
      );
    }
  }
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

function openExtensionContributionModal(detail: GeneratedPluginDetail) {
  if (
    !extensionContributionModal ||
    !extensionContributionCategory ||
    !extensionContributionTags ||
    !extensionContributionIcon ||
    !extensionContributionAuthor ||
    !extensionContributionHomepage ||
    !extensionContributionStatus ||
    !extensionContributionResult
  ) {
    return;
  }
  const defaults = contributionDefaults(detail.plugin, detail.manifestJson);
  activeExtensionContribution = { detail };
  if (extensionContributionTitle) {
    extensionContributionTitle.textContent = `Contribute · ${detail.plugin.name}`;
  }
  extensionContributionCategory.value = defaults.category;
  extensionContributionTags.value = defaults.tags.join(', ');
  extensionContributionIcon.value = defaults.icon;
  extensionContributionAuthor.value = defaults.author;
  extensionContributionHomepage.value = defaults.homepage;
  extensionContributionStatus.textContent = '';
  extensionContributionResult.innerHTML = '';
  extensionContributionResult.classList.add('is-hidden');
  extensionContributionCopy?.classList.add('is-hidden');
  extensionContributionReveal?.classList.add('is-hidden');
  extensionContributionPrepare?.classList.remove('is-hidden');
  setExtensionContributionBusy(false);
  extensionContributionModal.classList.remove('is-hidden');
  extensionContributionModal.setAttribute('aria-hidden', 'false');
  extensionContributionAuthor.focus();
}

function closeExtensionContributionModal() {
  activeExtensionContribution = null;
  extensionContributionModal?.classList.add('is-hidden');
  extensionContributionModal?.setAttribute('aria-hidden', 'true');
  if (extensionContributionStatus) extensionContributionStatus.textContent = '';
  pluginDetailView?.querySelector<HTMLButtonElement>('.plugin-detail-menu-toggle')?.focus();
}

function setExtensionContributionBusy(busy: boolean) {
  extensionContributionModal?.setAttribute('aria-busy', String(busy));
  for (const field of [
    extensionContributionCategory,
    extensionContributionTags,
    extensionContributionIcon,
    extensionContributionAuthor,
    extensionContributionHomepage,
    extensionContributionPrepare
  ]) {
    if (field) field.disabled = busy;
  }
}

async function prepareActiveExtensionContribution() {
  const active = activeExtensionContribution;
  if (
    !active ||
    !extensionContributionCategory ||
    !extensionContributionTags ||
    !extensionContributionIcon ||
    !extensionContributionAuthor ||
    !extensionContributionHomepage ||
    !extensionContributionStatus ||
    !extensionContributionResult
  ) {
    return;
  }
  const metadata: ExtensionContributionMetadata = {
    category: extensionContributionCategory.value,
    tags: parseContributionTags(extensionContributionTags.value),
    icon: extensionContributionIcon.value,
    author: extensionContributionAuthor.value,
    homepage: extensionContributionHomepage.value
  };
  setExtensionContributionBusy(true);
  extensionContributionStatus.textContent = 'Running mocked tests and discovering runtime tools…';
  try {
    const prepared = await invoke<PreparedExtensionContribution>('prepare_extension_contribution', {
      pluginId: active.detail.plugin.id,
      metadata
    });
    if (activeExtensionContribution !== active) return;
    active.prepared = prepared;
    extensionContributionStatus.textContent = 'Contribution bundle is ready.';
    extensionContributionResult.innerHTML = `
      <strong>${escapeHtml(prepared.title)}</strong>
      <p>${escapeHtml(prepared.folder)}</p>
      <ul>${prepared.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join('')}</ul>
    `;
    extensionContributionResult.classList.remove('is-hidden');
    extensionContributionPrepare?.classList.add('is-hidden');
    extensionContributionCopy?.classList.remove('is-hidden');
    extensionContributionReveal?.classList.remove('is-hidden');
  } catch (error) {
    if (activeExtensionContribution !== active) return;
    extensionContributionStatus.textContent = getErrorMessage(
      error,
      'Could not prepare the extension contribution.'
    );
  } finally {
    if (activeExtensionContribution === active) setExtensionContributionBusy(false);
  }
}

async function copyExtensionContributionPrompt() {
  const prepared = activeExtensionContribution?.prepared;
  if (!prepared || !extensionContributionStatus) return;
  const copied = await writeClipboard({ text: prepared.harnessPrompt });
  extensionContributionStatus.textContent = copied
    ? 'Harness prompt copied. Paste it into your coding agent while the Raynard repository is open.'
    : `Could not access the clipboard. Open ${prepared.promptPath} from the bundle instead.`;
}

async function revealExtensionContribution() {
  const prepared = activeExtensionContribution?.prepared;
  if (!prepared || !extensionContributionStatus) return;
  try {
    await invoke('open_extension_contribution_folder', { folder: prepared.folder });
    extensionContributionStatus.textContent = 'Opened the prepared contribution folder.';
  } catch (error) {
    extensionContributionStatus.textContent = getErrorMessage(
      error,
      'Could not open the contribution folder.'
    );
  }
}

/**
 * The extension detail screen, ordered by what the reader can act on: the name
 * and its key state, then the key itself, then what the extension does. Ids,
 * paths, and source are real debugging aids but they are not what the screen is
 * for, so they sit at the bottom behind a disclosure.
 */
function renderPluginDetail(
  detail: GeneratedPluginDetail,
  options: { availableExtension?: CatalogExtension } = {}
) {
  if (!pluginDetailView) return;
  const { plugin } = detail;
  const availableExtension = options.availableExtension;
  const readOnly = Boolean(availableExtension);
  const declaredCredentials = plugin.credentials || [];
  const requiresKey = availableExtension?.requiresKey ?? Boolean(declaredCredentials.length);
  const keyStatus = extensionKeyStatus(declaredCredentials, { readOnly, requiresKey });
  const keyAction = extensionKeyAction(declaredCredentials, { readOnly });
  const removalAction = extensionRemovalAction(plugin, catalogExtensions);
  const removalLabel = removalAction === 'uninstall' ? 'Uninstall' : 'Delete';
  const kicker = availableExtension
    ? 'Available Extension'
    : removalAction === 'uninstall'
      ? 'Installed Extension'
      : 'Your Extension';
  pluginDetailView.innerHTML = '';
  settingsToggle?.setAttribute('aria-pressed', 'false');

  const header = document.createElement('header');
  header.className = 'plugin-detail-header';
  const facts = [
    plugin.version ? `v${plugin.version}` : '',
    availableExtension?.category || '',
    availableExtension?.author ? `by ${availableExtension.author}` : '',
    `${plugin.tools.length || availableExtension?.tools?.length || 0} ${
      (plugin.tools.length || availableExtension?.tools?.length || 0) === 1 ? 'tool' : 'tools'
    }`
  ].filter(Boolean);
  header.innerHTML = `
    <div class="plugin-detail-title">
      <span class="plugin-detail-kicker">${kicker}</span>
      <h1>${escapeHtml(plugin.name)}</h1>
      <p>${escapeHtml(plugin.description || 'No description provided.')}</p>
      <div class="plugin-detail-facts">
        ${keyStatus
          ? `<span class="extension-requires-key-pill${keyStatus.configured ? ' is-configured' : ''}">${escapeHtml(keyStatus.text)}</span>`
          : ''}
        ${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join('')}
      </div>
    </div>
    ${availableExtension
      ? `<div class="plugin-detail-actions plugin-detail-install-actions">
          <button class="extensions-install-button plugin-detail-install" type="button">Install</button>
          <span class="plugin-detail-install-status" aria-live="polite"></span>
        </div>`
      : `<div class="plugin-detail-actions">
          ${keyAction
            ? `<button class="extensions-install-button plugin-detail-key" type="button" data-plugin-action="credentials">${escapeHtml(keyAction.label)}</button>`
            : ''}
          <button class="plugin-detail-menu-toggle" type="button" aria-label="Plugin options" aria-haspopup="menu" aria-expanded="false">
            ${iconSvg('ellipsis')}
          </button>
          <div class="plugin-detail-menu is-hidden" role="menu">
            ${keyAction
              ? `<button type="button" role="menuitem" data-plugin-action="credentials">
                  ${iconSvg('key')}
                  <span>${escapeHtml(keyAction.label)}</span>
                </button>`
              : ''}
            ${removalAction === 'delete'
              ? `<button type="button" role="menuitem" data-plugin-action="rename">
                  ${iconSvg('pencil')}
                  <span>Rename</span>
                </button>
                <button type="button" role="menuitem" data-plugin-action="contribute">
                  ${iconSvg('git-pull-request')}
                  <span>Prepare PR</span>
                </button>`
              : ''}
            <button type="button" role="menuitem" data-plugin-action="cache">
              ${iconSvg('database')}
              <span>Cache</span>
            </button>
            <button type="button" role="menuitem" class="is-danger" data-plugin-action="remove">
              ${iconSvg(removalAction === 'uninstall' ? 'package-minus' : 'trash-2')}
              <span>${removalLabel}</span>
            </button>
          </div>
        </div>`}
  `;
  const menuToggle = header.querySelector<HTMLButtonElement>('.plugin-detail-menu-toggle');
  const menu = header.querySelector<HTMLElement>('.plugin-detail-menu');
  menuToggle?.addEventListener('click', () => {
    const opening = menu?.classList.contains('is-hidden') ?? false;
    menu?.classList.toggle('is-hidden', !opening);
    menuToggle.setAttribute('aria-expanded', String(opening));
  });
  // The header button and the menu item are the same action.
  header.querySelectorAll<HTMLButtonElement>('[data-plugin-action="credentials"]').forEach((button) => {
    button.addEventListener('click', () => {
      closePluginDetailMenu();
      if (!keyAction) return;
      openPluginCredentialModal(plugin, credentialRequirements(plugin, keyAction.keys), () => {
        void openGeneratedPlugin(plugin.id);
      });
    });
  });
  header.querySelector<HTMLButtonElement>('[data-plugin-action="cache"]')?.addEventListener('click', () => {
    closePluginDetailMenu();
    void openPluginCacheModal(plugin.id, plugin.name);
  });
  header.querySelector<HTMLButtonElement>('[data-plugin-action="rename"]')?.addEventListener('click', () => {
    closePluginDetailMenu();
    openExtensionRenameModal(plugin);
  });
  header.querySelector<HTMLButtonElement>('[data-plugin-action="contribute"]')?.addEventListener('click', () => {
    closePluginDetailMenu();
    openExtensionContributionModal(detail);
  });
  header.querySelector<HTMLButtonElement>('[data-plugin-action="remove"]')?.addEventListener('click', () => {
    closePluginDetailMenu();
    void removeGeneratedPlugin(plugin.id);
  });
  const install = header.querySelector<HTMLButtonElement>('.plugin-detail-install');
  const installStatus = header.querySelector<HTMLElement>('.plugin-detail-install-status');
  install?.addEventListener('click', () => {
    if (!availableExtension) return;
    install.disabled = true;
    install.textContent = 'Installing...';
    if (installStatus) installStatus.textContent = '';
    void (async () => {
      try {
        const installed = await invoke<GeneratedPlugin>('install_catalog_extension', {
          slug: availableExtension.slug
        });
        await refreshGeneratedPlugins();
        await openGeneratedPlugin(installed.id);
      } catch (error) {
        install.disabled = false;
        install.textContent = 'Install';
        if (installStatus) {
          installStatus.textContent = getErrorMessage(
            error,
            `Could not install ${availableExtension.name}.`
          );
        }
      }
    })();
  });
  pluginDetailView.appendChild(header);

  const sections = new Map<ExtensionDetailSection, Node>();
  const credentials = buildPluginCredentialsSection(plugin, { readOnly });
  if (credentials) sections.set('setup', credentials);
  sections.set('tools', buildPluginToolsSection(plugin, availableExtension));
  sections.set('cards', buildPluginCardPreviewsSection(plugin));

  if (detail.readme.trim()) {
    const readme = document.createElement('section');
    readme.className = 'plugin-detail-section plugin-readme';
    readme.innerHTML = '<h2>README</h2>';
    const readmeBody = document.createElement('div');
    readmeBody.className = 'message-text';
    renderMessageText(readmeBody, detail.readme, true);
    readme.appendChild(readmeBody);
    sections.set('readme', readme);
  }

  sections.set('manifest', buildPluginManifestSection(detail, availableExtension));
  sections.set('source', createPluginCodeSection('tools.ts', detail.code || '// No tools.ts found.'));

  for (const name of extensionDetailSectionOrder({
    hasCredentials: Boolean(credentials),
    hasReadme: sections.has('readme')
  })) {
    const node = sections.get(name);
    if (node) pluginDetailView.appendChild(node);
  }
}

/** The declarations the credential modal needs, for a subset of a plugin's keys. */
function credentialRequirements(
  plugin: GeneratedPlugin,
  keys: string[]
): PluginCredentialRequirement[] {
  const wanted = new Set(keys);
  return (plugin.credentials || [])
    .filter((credential) => wanted.has(credential.key))
    .map((credential) => ({
      key: credential.key,
      label: credential.label,
      description: credential.description,
      signupUrl: credential.signupUrl
    }));
}

/**
 * One collapsed row per tool. A tool description is written for the model and
 * routinely runs to a paragraph, so the row shows its first sentence and keeps
 * the rest, plus the parameter schema, behind the disclosure.
 */
function buildPluginToolsSection(
  plugin: GeneratedPlugin,
  availableExtension?: CatalogExtension
) {
  const tools = document.createElement('section');
  tools.className = 'plugin-detail-section';
  tools.innerHTML = '<h2>Tools</h2>';
  const detailTools = plugin.tools.length ? plugin.tools : availableExtension?.tools ?? [];
  if (!detailTools.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-detail-empty';
    empty.textContent = 'This plugin manifest does not declare any tools.';
    tools.appendChild(empty);
    return tools;
  }

  const list = document.createElement('div');
  list.className = 'plugin-tool-list';
  for (const tool of detailTools) {
    const description = tool.description || 'No description provided.';
    const summaryLine = extensionToolSummary(description);

    const row = document.createElement('details');
    row.className = 'plugin-tool-row';
    const summary = document.createElement('summary');
    const name = document.createElement('code');
    name.textContent = tool.name;
    summary.appendChild(name);
    const lead = document.createElement('span');
    lead.className = 'plugin-tool-lead';
    lead.textContent = summaryLine;
    summary.appendChild(lead);
    row.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'plugin-tool-body';
    if (description !== summaryLine) {
      const full = document.createElement('p');
      full.textContent = description;
      body.appendChild(full);
    }

    if ('parameters' in tool) {
      const parameters = extensionToolParameters(tool.parameters);
      const heading = document.createElement('p');
      heading.className = 'plugin-tool-params-heading';
      heading.textContent = parameters.length ? 'Parameters' : 'Takes no arguments.';
      body.appendChild(heading);
      if (parameters.length) {
        const params = document.createElement('div');
        params.className = 'plugin-tool-params';
        for (const parameter of parameters) {
          const item = document.createElement('div');
          item.className = 'plugin-tool-param';
          const label = document.createElement('span');
          label.className = 'plugin-tool-param-name';
          const paramName = document.createElement('code');
          paramName.textContent = parameter.name;
          label.appendChild(paramName);
          const type = document.createElement('span');
          type.className = 'plugin-tool-param-type';
          type.textContent = parameter.type;
          label.appendChild(type);
          if (parameter.required) {
            const required = document.createElement('span');
            required.className = 'plugin-tool-param-required';
            required.textContent = 'required';
            label.appendChild(required);
          }
          item.appendChild(label);
          if (parameter.description) {
            const text = document.createElement('p');
            text.textContent = parameter.description;
            item.appendChild(text);
          }
          params.appendChild(item);
        }
        body.appendChild(params);
      }
    } else if (tool.hasCard) {
      const card = document.createElement('p');
      card.className = 'plugin-tool-params-heading';
      card.textContent = 'Renders a result card.';
      body.appendChild(card);
    }

    row.appendChild(body);
    list.appendChild(row);
  }
  tools.appendChild(list);
  return tools;
}

/**
 * The manifest, read rather than dumped: what the extension is about and where
 * its data comes from, with the ids, paths, and raw JSON kept one click away.
 */
function buildPluginManifestSection(
  detail: GeneratedPluginDetail,
  availableExtension?: CatalogExtension
) {
  const { plugin } = detail;
  const metadata = extensionManifestMetadata(detail.manifestJson);
  const category = metadata.category || availableExtension?.category || '';
  const author = metadata.author || availableExtension?.author || '';
  const homepage = metadata.homepage || availableExtension?.homepage || '';

  const section = document.createElement('section');
  section.className = 'plugin-detail-section plugin-manifest-section';
  section.innerHTML = '<h2>Manifest</h2>';

  const facts = document.createElement('dl');
  facts.className = 'plugin-manifest-facts';
  const appendFact = (label: string, value: Node | string) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (typeof value === 'string') dd.textContent = value;
    else dd.appendChild(value);
    facts.append(dt, dd);
  };
  const externalLink = (href: string, text: string) => {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = text;
    link.title = href;
    return link;
  };

  if (category) appendFact('Category', category);
  if (author) appendFact('Author', author);
  if (metadata.license) appendFact('License', metadata.license);
  appendFact('Version', plugin.version || 'n/a');
  if (metadata.sdkVersion) appendFact('SDK', `v${metadata.sdkVersion}`);
  appendFact('Status', availableExtension ? 'Available' : plugin.status || 'n/a');
  if (homepage) appendFact('Homepage', externalLink(homepage, extensionSourceLabel(homepage)));
  if (metadata.tags.length) {
    const tags = document.createElement('span');
    tags.className = 'plugin-manifest-tags';
    for (const tag of metadata.tags) {
      const pill = document.createElement('span');
      pill.className = 'plugin-manifest-tag';
      pill.textContent = tag;
      tags.appendChild(pill);
    }
    appendFact('Tags', tags);
  }
  if (metadata.sources.length) {
    const sources = document.createElement('span');
    sources.className = 'plugin-manifest-sources';
    for (const source of metadata.sources) {
      sources.appendChild(externalLink(source, extensionSourceLabel(source)));
    }
    appendFact('Documentation', sources);
  }
  section.appendChild(facts);

  // Ids and filesystem paths are debugging aids, not what the screen is for.
  const paths = document.createElement('details');
  paths.className = 'plugin-detail-facts-block';
  const pathsSummary = document.createElement('summary');
  pathsSummary.textContent = 'Files and ids';
  paths.appendChild(pathsSummary);
  const meta = document.createElement('dl');
  meta.className = 'plugin-detail-meta';
  appendPluginResultRow(meta, 'ID', plugin.id);
  appendPluginResultRow(meta, 'Created', plugin.createdAt || 'n/a');
  appendPluginResultRow(meta, 'Directory', plugin.directory);
  appendPluginResultRow(meta, 'Manifest', plugin.manifestPath);
  appendPluginResultRow(meta, 'Entrypoint', plugin.entryPath);
  paths.appendChild(meta);
  section.appendChild(paths);

  const raw = document.createElement('details');
  raw.className = 'plugin-detail-facts-block';
  const rawSummary = document.createElement('summary');
  rawSummary.textContent = 'Raw plugin.json';
  raw.appendChild(rawSummary);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = detail.manifestText || '';
  pre.appendChild(code);
  raw.appendChild(pre);
  section.appendChild(raw);

  return section;
}

function buildPluginCredentialsSection(
  plugin: GeneratedPlugin,
  options: { readOnly?: boolean } = {}
): HTMLElement | null {
  const declared = plugin.credentials || [];
  // An extension with no keys says nothing rather than reserving a section to
  // announce that there is nothing to do.
  if (!declared.length) return null;

  const section = document.createElement('section');
  section.className = 'plugin-detail-section plugin-detail-setup';
  section.innerHTML = '<h2>API keys</h2>';

  const hint = options.readOnly
    ? 'This extension asks for a key once it is installed.'
    : extensionKeyHint(declared);
  if (hint) {
    const line = document.createElement('p');
    line.className = 'plugin-detail-hint';
    line.textContent = hint;
    section.appendChild(line);
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
    pill.className = `plugin-credential-pill${credential.configured && !options.readOnly ? ' is-configured' : ''}`;
    pill.textContent = options.readOnly
      ? 'Required after install'
      : credential.configured
        ? 'Configured'
        : 'Not configured';
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

    if (!options.readOnly) {
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
    }

    if (credential.configured && !options.readOnly) {
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

    if (actions.childElementCount) row.appendChild(actions);
    list.appendChild(row);
  }

  section.appendChild(list);
  return section;
}

// Preview every plugin tool's result card using synthesized example data. Each
// preview is a fold: a rendered card is tall, and nine of them are a scroll.
function buildPluginCardPreviewsSection(plugin: GeneratedPlugin) {
  const cardTools = plugin.tools;

  const section = document.createElement('section');
  section.className = 'plugin-detail-section';
  section.innerHTML = '<h2>Result cards</h2>';

  if (!cardTools.length) {
    const empty = document.createElement('p');
    empty.className = 'plugin-detail-empty';
    empty.textContent = 'No valid runtime tools were discovered for this plugin.';
    section.appendChild(empty);
    return section;
  }

  const hint = document.createElement('p');
  hint.className = 'plugin-detail-hint';
  hint.textContent = 'How these tools render their results, shown with example data.';
  section.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'plugin-card-preview-list';
  for (const tool of cardTools) {
    const template = tool.card as CardTemplate;
    const block = document.createElement('details');
    block.className = 'plugin-card-preview';
    const summary = document.createElement('summary');
    const label = document.createElement('code');
    label.className = 'plugin-card-preview-tool';
    label.textContent = tool.name;
    summary.appendChild(label);
    block.appendChild(summary);
    const mount = document.createElement('div');
    mount.className = 'plugin-card-preview-body';
    block.appendChild(mount);
    // The card is only mounted once its fold is opened; React work for a card
    // nobody looked at is work the screen does not need to do.
    let mounted = false;
    block.addEventListener('toggle', () => {
      if (!block.open || mounted) return;
      mounted = true;
      renderResultCards(
        mount,
        [{ toolName: tool.name, template, data: buildExampleData(template) }],
        { collapsible: false }
      );
    });
    list.appendChild(block);
  }
  section.appendChild(list);
  return section;
}

function stringifyPromptJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/** A source file, folded shut: it is reference material, not the screen's subject. */
function createPluginCodeSection(title: string, codeText: string) {
  const section = document.createElement('details');
  section.className = 'plugin-detail-section plugin-code-section';
  const heading = document.createElement('summary');
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
    if (chatHistoryStatus && sidebarView === 'chats') {
      chatHistoryStatus.textContent = sidebarStatusText('chats');
    }
  } catch (error) {
    if (chatHistoryStatus && sidebarView === 'chats') {
      chatHistoryStatus.textContent = getErrorMessage(error, 'Could not load chats.');
    }
  }
}

async function refreshBookmarks(reset: boolean) {
  if (bookmarkLoading) {
    bookmarkRefreshQueued ||= reset;
    return;
  }
  bookmarkLoading = true;
  if (reset) {
    bookmarkRows = [];
    bookmarkTotal = 0;
  }
  renderBookmarks();
  if (chatHistoryStatus && sidebarView === 'bookmarks') {
    chatHistoryStatus.textContent = sidebarStatusText('bookmarks');
  }
  let loadError = '';
  try {
    const result = await invoke<BookmarkList>('list_bookmarks', {
      offset: reset ? 0 : bookmarkRows.length,
      limit: BOOKMARK_PAGE_SIZE
    });
    bookmarkRows = reset ? result.bookmarks : [...bookmarkRows, ...result.bookmarks];
    bookmarkTotal = result.total;
    renderBookmarks();
    if (chatHistoryStatus && sidebarView === 'bookmarks') {
      chatHistoryStatus.textContent = sidebarStatusText('bookmarks');
    }
  } catch (error) {
    loadError = getErrorMessage(error, 'Could not load bookmarks.');
  } finally {
    bookmarkLoading = false;
    renderBookmarks();
    if (chatHistoryStatus && sidebarView === 'bookmarks') {
      chatHistoryStatus.textContent = loadError || sidebarStatusText('bookmarks');
    }
    if (bookmarkRefreshQueued) {
      bookmarkRefreshQueued = false;
      void refreshBookmarks(true);
    }
  }
}

function renderBookmarks() {
  if (!bookmarkList) return;
  bookmarkList.replaceChildren();
  for (const bookmark of bookmarkRows) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'bookmark-row';
    open.setAttribute('aria-label', `Open bookmarked answer for: ${bookmark.prompt}`);

    const prompt = document.createElement('strong');
    prompt.className = 'bookmark-row-prompt';
    prompt.textContent = bookmarkPreview(bookmark.prompt, 100);
    const answer = document.createElement('span');
    answer.className = 'bookmark-row-answer';
    answer.textContent = bookmarkPreview(bookmark.answer, 220);
    const meta = document.createElement('span');
    meta.className = 'bookmark-row-meta';
    meta.textContent = `${bookmark.chatName} · ${formatChatDate(new Date(bookmark.createdAt).toISOString())}`;
    open.append(prompt, answer, meta);
    open.addEventListener('click', () => void openBookmarkedAnswer(bookmark));
    bookmarkList.appendChild(open);
  }

  if (bookmarkRows.length < bookmarkTotal) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'bookmark-load-more';
    more.textContent = bookmarkLoading ? 'Loading…' : `Load more (${bookmarkTotal - bookmarkRows.length})`;
    more.disabled = bookmarkLoading;
    more.addEventListener('click', () => void refreshBookmarks(false));
    bookmarkList.appendChild(more);
  }
}

async function refreshScheduledTasks() {
  try {
    scheduledTasks = await invoke<ScheduledTask[]>('list_scheduled_tasks');
    renderScheduledTasks();
    if (sidebarView === 'scheduled' && chatHistoryStatus) {
      chatHistoryStatus.textContent = sidebarStatusText('scheduled');
    }
  } catch (error) {
    if (sidebarView === 'scheduled' && chatHistoryStatus) {
      chatHistoryStatus.textContent = getErrorMessage(error, 'Could not load scheduled tasks.');
    }
  }
}

function renderScheduledTasks() {
  if (!scheduledTaskList) return;
  scheduledTaskList.replaceChildren();
  const now = Date.now();
  for (const task of scheduledTasks) {
    const status = taskStatus(task);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'scheduled-task-row';
    row.classList.toggle('is-paused', !task.enabled && !task.activeExecutionId);
    row.classList.toggle('is-active', task.id === activeScheduledTaskId);
    const top = document.createElement('span');
    top.className = 'scheduled-task-row-top';
    const dot = document.createElement('span');
    dot.className = 'scheduled-task-dot';
    dot.dataset.tone = status.tone;
    const title = document.createElement('strong');
    title.textContent = task.name;
    top.append(dot, title);
    const schedule = document.createElement('span');
    schedule.className = 'scheduled-task-row-meta';
    schedule.textContent = scheduleShorthand(task.schedule);
    const next = document.createElement('span');
    next.className = 'scheduled-task-row-next';
    next.textContent = task.activeExecutionId
      ? 'Running now'
      : task.enabled
        ? `Next ${relativeRunLabel(task.nextRunAt, now)}`
        : 'Paused';
    row.append(top, schedule, next);
    row.addEventListener('click', () => openScheduledTask(task));
    scheduledTaskList.appendChild(row);
  }
}

function taskDraftFromForm(form: HTMLFormElement, fallback: ScheduledTaskRequest): ScheduledTaskRequest {
  const data = new FormData(form);
  const frequency = String(data.get('frequency')) as ScheduledTaskRequest['schedule']['frequency'];
  const destination = String(data.get('destination'));
  const fields = calendarFieldsFor(frequency);
  return {
    name: String(data.get('name') || '').trim(),
    prompt: String(data.get('prompt') || '').trim(),
    destinationType: destination === 'newChat' ? 'newChat' : 'existingChat',
    destinationChatId:
      destination === 'newChat'
        ? fallback.destinationType === 'newChat'
          ? fallback.destinationChatId
          : undefined
        : destination,
    schedule: {
      frequency,
      time: String(data.get('time') || ''),
      timeZone: fallback.schedule.timeZone,
      dayOfWeek: fields.weekday ? Number(data.get('dayOfWeek')) : undefined,
      dayOfMonth: fields.day ? Number(data.get('dayOfMonth')) : undefined,
      monthOfYear: fields.month ? Number(data.get('monthOfYear')) : undefined
    }
  };
}

const TASK_FREQUENCIES: Array<{ value: ScheduledTaskRequest['schedule']['frequency']; label: string }> = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' }
];

const TASK_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

function renderTaskEditor(
  root: HTMLElement,
  draft: ScheduledTaskRequest,
  options: {
    submitLabel: string;
    variant?: 'page' | 'panel';
    onSubmit: (draft: ScheduledTaskRequest, status: HTMLElement) => Promise<void>;
  }
) {
  const variant = options.variant ?? 'panel';
  root.replaceChildren();
  const form = document.createElement('form');
  form.className = `task-editor task-editor--${variant}`;
  form.innerHTML = `
    <section class="task-editor-section">
      <h2 class="task-editor-heading">Task</h2>
      <label class="task-field">
        <span class="task-field-label">Name</span>
        <input name="name" required maxlength="120" placeholder="Daily briefing">
      </label>
      <label class="task-field">
        <span class="task-field-label">Prompt</span>
        <textarea name="prompt" required rows="4" placeholder="Describe exactly what to do on each run."></textarea>
        <span class="task-field-hint">Every run starts fresh, so the prompt has to stand on its own.</span>
      </label>
    </section>

    <section class="task-editor-section">
      <h2 class="task-editor-heading">Schedule</h2>
      <div class="task-segmented" role="radiogroup" aria-label="Repeats">
        ${TASK_FREQUENCIES.map(
          (entry) =>
            `<button type="button" role="radio" aria-checked="false" data-frequency="${entry.value}">${entry.label}</button>`
        ).join('')}
      </div>
      <input type="hidden" name="frequency" value="daily">
      <div class="task-schedule-grid">
        <label class="task-field">
          <span class="task-field-label">Time</span>
          <input name="time" type="time" required>
        </label>
        <label class="task-field" data-calendar-field="weekday">
          <span class="task-field-label">Weekday</span>
          <select name="dayOfWeek">
            <option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option>
            <option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option>
            <option value="7">Sunday</option>
          </select>
        </label>
        <label class="task-field" data-calendar-field="day">
          <span class="task-field-label">Day of month</span>
          <input name="dayOfMonth" type="number" min="1" max="31">
        </label>
        <label class="task-field" data-calendar-field="month">
          <span class="task-field-label">Anchor month</span>
          <select name="monthOfYear">
            ${TASK_MONTHS.map((month, index) => `<option value="${index + 1}">${month}</option>`).join('')}
          </select>
        </label>
      </div>
      <p class="task-schedule-summary">
        <span class="task-schedule-summary-icon" aria-hidden="true">${iconSvg('stopwatch')}</span>
        <span class="task-schedule-summary-text"></span>
      </p>
    </section>

    <section class="task-editor-section">
      <h2 class="task-editor-heading">Destination</h2>
      <label class="task-field">
        <span class="task-field-label">Post results to</span>
        <select name="destination"></select>
        <span class="task-field-hint">A dedicated chat is created on the first run and reused after that.</span>
      </label>
    </section>

    <footer class="task-editor-footer">
      <p class="task-form-status" aria-live="polite"></p>
      <div class="task-editor-buttons">
        <button type="button" class="task-editor-discard is-hidden">Discard</button>
        <button type="submit" class="capability-primary-action task-editor-save"></button>
      </div>
    </footer>
  `;
  const name = form.elements.namedItem('name') as HTMLInputElement;
  const prompt = form.elements.namedItem('prompt') as HTMLTextAreaElement;
  const destination = form.elements.namedItem('destination') as HTMLSelectElement;
  const frequency = form.elements.namedItem('frequency') as HTMLInputElement;
  const time = form.elements.namedItem('time') as HTMLInputElement;
  const weekday = form.elements.namedItem('dayOfWeek') as HTMLSelectElement;
  const day = form.elements.namedItem('dayOfMonth') as HTMLInputElement;
  const month = form.elements.namedItem('monthOfYear') as HTMLSelectElement;
  name.value = draft.name;
  prompt.value = draft.prompt;
  destination.add(new Option('Dedicated task chat', 'newChat'));
  for (const chat of chatHistoryRows) destination.add(new Option(chat.name, chat.chatId));
  if (
    draft.destinationType === 'existingChat' &&
    draft.destinationChatId &&
    !chatHistoryRows.some((chat) => chat.chatId === draft.destinationChatId)
  ) {
    destination.add(
      new Option(
        draft.destinationChatId === activeChatMeta.chatId ? activeChatMeta.name : 'Selected chat',
        draft.destinationChatId
      )
    );
  }
  destination.value = draft.destinationType === 'existingChat' ? draft.destinationChatId || '' : 'newChat';
  if (!destination.value) destination.value = 'newChat';
  frequency.value = draft.schedule.frequency;
  time.value = draft.schedule.time;
  weekday.value = String(draft.schedule.dayOfWeek || 1);
  day.value = String(draft.schedule.dayOfMonth || 1);
  month.value = String(draft.schedule.monthOfYear || 1);

  const save = form.querySelector<HTMLButtonElement>('.task-editor-save');
  const discard = form.querySelector<HTMLButtonElement>('.task-editor-discard');
  const status = form.querySelector<HTMLElement>('.task-form-status');
  const summary = form.querySelector<HTMLElement>('.task-schedule-summary-text');
  if (save) save.textContent = options.submitLabel;

  const syncFields = () => {
    const fields = calendarFieldsFor(frequency.value);
    for (const button of form.querySelectorAll<HTMLButtonElement>('.task-segmented button')) {
      const selected = button.dataset.frequency === frequency.value;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-checked', String(selected));
    }
    form
      .querySelector<HTMLElement>('[data-calendar-field="weekday"]')
      ?.classList.toggle('is-hidden', !fields.weekday);
    form.querySelector<HTMLElement>('[data-calendar-field="day"]')?.classList.toggle('is-hidden', !fields.day);
    form
      .querySelector<HTMLElement>('[data-calendar-field="month"]')
      ?.classList.toggle('is-hidden', !fields.month);
    if (summary) {
      const current = taskDraftFromForm(form, draft).schedule;
      summary.textContent = `${scheduleSentence(current)} · ${current.timeZone}`;
    }
  };

  // The page editor only offers a save once something actually changed, so the
  // detail screen does not look like an unsaved form on every visit.
  const baseline = () => JSON.stringify(taskDraftFromForm(form, draft));
  let saved = baseline();
  const syncDirty = () => {
    if (variant !== 'page' || !save) return;
    const dirty = baseline() !== saved;
    form.dataset.dirty = String(dirty);
    save.disabled = !dirty;
    discard?.classList.toggle('is-hidden', !dirty);
    if (status) status.textContent = dirty ? 'Unsaved changes' : '';
  };

  for (const button of form.querySelectorAll<HTMLButtonElement>('.task-segmented button')) {
    button.addEventListener('click', () => {
      frequency.value = button.dataset.frequency || 'daily';
      syncFields();
      syncDirty();
    });
  }
  form.addEventListener('input', () => {
    syncFields();
    syncDirty();
  });
  form.addEventListener('change', () => {
    syncFields();
    syncDirty();
  });
  discard?.addEventListener('click', () => {
    renderTaskEditor(root, draft, options);
  });
  syncFields();
  syncDirty();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!status || !save) return;
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      await options.onSubmit(taskDraftFromForm(form, draft), status);
      saved = baseline();
      syncDirty();
    } catch (error) {
      status.textContent = getErrorMessage(error, 'Could not save the task.');
      save.disabled = false;
    }
  });
  root.appendChild(form);
}

function taskStatTile(label: string, value: string, note?: { text: string; tone?: RunTone }) {
  const tile = document.createElement('div');
  tile.className = 'task-stat';
  const caption = document.createElement('span');
  caption.className = 'task-stat-label';
  caption.textContent = label;
  const strong = document.createElement('strong');
  strong.className = 'task-stat-value';
  strong.textContent = value;
  tile.append(caption, strong);
  if (note) {
    const hint = document.createElement('span');
    hint.className = 'task-stat-note';
    if (note.tone) hint.dataset.tone = note.tone;
    hint.textContent = note.text;
    tile.appendChild(hint);
  }
  return tile;
}

function openScheduledTask(task: ScheduledTask) {
  if (!pluginDetailView || !messages) return;
  mainViewRevision += 1;
  activeScheduledTaskId = task.id;
  renderScheduledTasks();
  pluginDetailView.replaceChildren();
  settingsToggle?.setAttribute('aria-pressed', 'false');
  const status = taskStatus(task);
  const now = Date.now();

  const header = document.createElement('header');
  header.className = 'plugin-detail-header task-detail-header';
  header.dataset.scheduledTaskId = task.id;
  header.innerHTML = `
    <div class="plugin-detail-title">
      <span class="plugin-detail-kicker">Scheduled task</span>
      <h1>${escapeHtml(task.name)}</h1>
      <p class="task-status-line">
        <span class="task-status-pill" data-tone="${status.tone}">${escapeHtml(status.label)}</span>
        <span>${escapeHtml(scheduleSentence(task.schedule))}</span>
        <span class="task-status-zone">${escapeHtml(task.schedule.timeZone)}</span>
      </p>
    </div>
    <div class="plugin-detail-actions task-detail-header-actions">
      <button class="task-run-now" type="button">${iconSvg('play')}<span>Run now</span></button>
      <button class="plugin-detail-menu-toggle" type="button" aria-label="Task options" aria-haspopup="menu" aria-expanded="false">
        ${iconSvg('ellipsis')}
      </button>
      <div class="plugin-detail-menu is-hidden" role="menu">
        <button type="button" role="menuitem" data-task-action="toggle">
          ${iconSvg(task.enabled ? 'pause' : 'play')}
          <span>${task.enabled ? 'Pause task' : 'Resume task'}</span>
        </button>
        ${task.destinationChatId
          ? `<button type="button" role="menuitem" data-task-action="open-chat">
              ${iconSvg('message-square')}
              <span>Open chat</span>
            </button>`
          : ''}
        <button type="button" role="menuitem" class="is-danger" data-task-action="delete">
          ${iconSvg('trash-2')}
          <span>Delete task</span>
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
  const runNow = header.querySelector<HTMLButtonElement>('.task-run-now');
  if (runNow) {
    runNow.disabled = Boolean(task.activeExecutionId);
    runNow.addEventListener('click', () => {
      runNow.disabled = true;
      const label = runNow.querySelector('span');
      if (label) label.textContent = 'Queued';
      queueScheduledTask(task.id, true);
    });
  }
  header
    .querySelector<HTMLButtonElement>('[data-task-action="toggle"]')
    ?.addEventListener('click', async () => {
      closePluginDetailMenu();
      const updated = await invoke<ScheduledTask>('set_scheduled_task_enabled', {
        taskId: task.id,
        enabled: !task.enabled
      });
      await refreshScheduledTasks();
      openScheduledTask(updated);
    });
  header
    .querySelector<HTMLButtonElement>('[data-task-action="open-chat"]')
    ?.addEventListener('click', () => {
      closePluginDetailMenu();
      if (task.destinationChatId) void openSavedChat(task.destinationChatId);
    });
  header
    .querySelector<HTMLButtonElement>('[data-task-action="delete"]')
    ?.addEventListener('click', async () => {
      closePluginDetailMenu();
      if (task.activeExecutionId) return;
      await invoke('delete_scheduled_task', { taskId: task.id });
      activeScheduledTaskId = null;
      await refreshScheduledTasks();
      showConversation();
    });
  pluginDetailView.appendChild(header);

  const stats = document.createElement('section');
  stats.className = 'task-stat-row';
  stats.appendChild(
    taskStatTile(
      'Next run',
      task.activeExecutionId ? 'Running now' : task.enabled ? formatChatDate(task.nextRunAt) : 'Not scheduled',
      task.enabled && !task.activeExecutionId
        ? { text: relativeRunLabel(task.nextRunAt, now) }
        : { text: task.activeExecutionId ? 'Started just now' : 'Resume to schedule the next run' }
    )
  );
  const lastRun = runStatusLabel(task.lastStatus);
  stats.appendChild(
    taskStatTile(
      'Last run',
      task.lastRunAt ? formatChatDate(task.lastRunAt) : 'Never run',
      task.lastRunAt
        ? { text: task.lastError ? `${lastRun.label} · ${task.lastError}` : lastRun.label, tone: lastRun.tone }
        : { text: 'This task has not run yet' }
    )
  );
  const destinationChat = task.destinationChatId
    ? chatHistoryRows.find((chat) => chat.chatId === task.destinationChatId)
    : undefined;
  stats.appendChild(
    taskStatTile(
      'Destination',
      task.destinationType === 'newChat' ? 'Dedicated task chat' : destinationChat?.name || 'Selected chat',
      {
        text: task.destinationChatId
          ? 'Results append to that chat'
          : 'A chat is created on the first run'
      }
    )
  );
  pluginDetailView.appendChild(stats);

  const editor = document.createElement('section');
  editor.className = 'plugin-detail-section';
  pluginDetailView.appendChild(editor);
  renderTaskEditor(editor, task, {
    submitLabel: 'Save changes',
    variant: 'page',
    onSubmit: async (draft, formStatus) => {
      const updated = await invoke<ScheduledTask>('update_scheduled_task', { taskId: task.id, draft });
      formStatus.textContent = 'Saved.';
      await refreshScheduledTasks();
      openScheduledTask(updated);
    }
  });

  shell?.classList.add('plugin-view');
  shell?.classList.remove('pre-chat');
  pluginDetailView.classList.remove('is-hidden');
  messages.classList.add('is-hidden');
  chatForm?.classList.add('is-hidden');
  document.querySelector<HTMLElement>('.intro-stage')?.classList.add('is-hidden');
}


async function enqueueDueScheduledTasks() {
  if (!llmEnvStatus?.configured) return;
  try {
    const due = await invoke<ScheduledTask[]>('list_due_scheduled_tasks');
    for (const task of due) queueScheduledTask(task.id, false);
  } catch {
    // Provider onboarding or an older host can make startup temporarily unable
    // to run tasks. The next host wake retries without losing the due time.
  }
}

function queueScheduledTask(taskId: string, manual: boolean) {
  if (!scheduledTaskQueue.some((entry) => entry.taskId === taskId)) {
    scheduledTaskQueue.push({ taskId, manual });
  }
  void drainScheduledTaskQueue();
}

function refreshOpenScheduledTask(taskId: string) {
  if (activeScheduledTaskId !== taskId || !pluginDetailView) return;
  const header = pluginDetailView.querySelector<HTMLElement>('.task-detail-header');
  if (header?.dataset.scheduledTaskId !== taskId) return;
  const task = scheduledTasks.find((entry) => entry.id === taskId);
  if (!task) return;

  const editor = pluginDetailView.querySelector<HTMLFormElement>('.task-editor--page');
  if (editor?.dataset.dirty === 'true') {
    const runNow = header.querySelector<HTMLButtonElement>('.task-run-now');
    if (!runNow) return;
    runNow.disabled = Boolean(task.activeExecutionId);
    const label = runNow.querySelector('span');
    if (label) label.textContent = task.activeExecutionId ? 'Running now' : 'Run now';
    return;
  }

  openScheduledTask(task);
}

async function drainScheduledTaskQueue() {
  if (scheduledTaskRunnerActive) return;
  const next = scheduledTaskQueue.shift();
  if (!next) return;
  const known = scheduledTasks.find((task) => task.id === next.taskId);
  if (known?.destinationChatId && chatRuns.has(known.destinationChatId)) {
    scheduledTaskQueue.push(next);
    window.setTimeout(() => void drainScheduledTaskQueue(), 2_000);
    return;
  }
  scheduledTaskRunnerActive = true;
  try {
    const execution = await invoke<ScheduledExecution>('claim_scheduled_task', {
      taskId: next.taskId,
      manual: next.manual
    });
    await refreshScheduledTasks();
    refreshOpenScheduledTask(next.taskId);
    await runScheduledExecution(execution);
  } catch (error) {
    console.error('Could not run scheduled task:', getErrorMessage(error));
  } finally {
    scheduledTaskRunnerActive = false;
    await refreshScheduledTasks();
    refreshOpenScheduledTask(next.taskId);
    void drainScheduledTaskQueue();
  }
}

async function scheduledChatSnapshot(task: ScheduledTask): Promise<{
  meta: ChatMeta;
  stored: StoredChatMessage[];
}> {
  if (task.destinationChatId) {
    const chat = await invoke<ChatHistoryPayload>('read_chat_history', {
      chatId: task.destinationChatId
    });
    return {
      meta: {
        chatId: chat.chatId,
        name: chat.name,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        unread: chat.unread,
        activeBuildPlugin: chat.activeBuildPlugin
      },
      stored: recoverInterruptedMessages(chat.messages).messages
    };
  }
  const chatId = createSessionId();
  const meta = createChatMeta(chatId, task.name);
  meta.name = `Scheduled · ${task.name}`;
  return { meta, stored: [] };
}

async function runScheduledExecution(execution: ScheduledExecution) {
  const task = execution.task;
  let destinationChatId: string | undefined;
  let completionStatus = 'completed';
  let completionError: string | undefined;
  try {
    const snapshot = await scheduledChatSnapshot(task);
    destinationChatId = snapshot.meta.chatId;
    if (chatRuns.has(destinationChatId)) {
      throw new Error('The destination chat is busy. Use Run now after its current turn finishes.');
    }
    const userRecord: StoredChatMessage = {
      role: 'user',
      text: task.prompt,
      timestamp: Date.now(),
      scheduledTaskName: task.name,
      scheduledExecutionId: execution.executionId
    };
    const assistantRecord: StoredChatMessage = {
      role: 'assistant',
      text: 'Thinking…',
      timestamp: Date.now(),
      status: 'running',
      scheduledTaskName: task.name,
      scheduledExecutionId: execution.executionId
    };
    snapshot.stored.push(userRecord, assistantRecord);
    const modelMessages = snapshot.stored
      .slice(0, -1)
      .filter((message) => !message.modeStatus)
      .map((message) => ({ role: message.role, content: message.text }));
    const run = chatRuns.begin(
      destinationChatId,
      'scheduled',
      snapshot.meta,
      snapshot.stored,
      mainViewRevision
    );
    if (!run) throw new Error('The destination chat is already running.');
    const refreshVisible = () => {
      if (activeSessionId !== destinationChatId) return;
      bindChatState(snapshot.meta, snapshot.stored);
      renderStoredTranscript();
      syncRunControls();
    };
    await persistChatSnapshot(snapshot.meta, snapshot.stored);
    if (!task.destinationChatId) {
      await invoke('assign_scheduled_task_chat', {
        taskId: task.id,
        executionId: execution.executionId,
        chatId: destinationChatId
      });
    }
    await refreshChatHistory();
    refreshVisible();
    let streamed = '';
    let thinking = '';
    let credentialRequest: CredentialRequest | undefined;
    let recommendation: ExtensionRecommendation | undefined;
    try {
      const reply = await runMainAgentStream(
        modelMessages,
        'explore',
        {
          onStreamId: (streamId) => {
            chatRuns.setStreamId(destinationChatId!, run.id, streamId);
            syncRunControls();
          },
          onDelta: (delta) => {
            streamed += delta;
            assistantRecord.text = streamed || 'Thinking…';
            refreshVisible();
          },
          onThinkingDelta: (delta) => {
            thinking += delta;
            assistantRecord.thinking = thinking.trim() || undefined;
          },
          onToolResult: (toolCall) => {
            const chart = extractPresentedChart(toolCall.result);
            if (chart) (assistantRecord.charts ??= []).push(chart);
            const pluginName = pluginNameForTool(toolCall.toolName);
            const card = extractResultCard(toolCall, pluginName);
            let cardIndex: number | undefined;
            if (card) cardIndex = (assistantRecord.cards ??= []).push(card) - 1;
            const source = extractToolSource(toolCall.result, toolCall.toolName, pluginName);
            if (source && cardIndex !== undefined) source.cardIndex = cardIndex;
            if (source) (assistantRecord.sources ??= []).push(source);
            persistChatSnapshotQuietly(snapshot.meta, snapshot.stored);
            refreshVisible();
          },
          onCredentialRequest: (request) => {
            credentialRequest = request;
          },
          onExtensionRecommendation: (nextRecommendation) => {
            recommendation = nextRecommendation;
          }
        },
        destinationChatId,
        true
      );
      if (credentialRequest) {
        assistantRecord.credentialRequest = credentialRequest;
        assistantRecord.text = credentialPromptCopy(credentialRequest).title;
      } else if (reply.buildRequest) {
        assistantRecord.text = `This scheduled run needs approval to build ${reply.buildRequest.name}. Open the chat and ask again to review the plugin build.`;
      } else {
        assistantRecord.text = reply.content || streamed || 'The model returned an empty response.';
      }
      assistantRecord.extensionRecommendation = recommendation ?? reply.extensionRecommendation;
      assistantRecord.provider = reply.provider;
      assistantRecord.model = reply.model;
      assistantRecord.usage = reply.usage;
      assistantRecord.thinking = thinking.trim() || undefined;
      assistantRecord.status = 'completed';
      assistantRecord.timestamp = Date.now();
      await persistChatSnapshot(snapshot.meta, snapshot.stored);
      await refreshChatHistory();
      refreshVisible();
    } catch (error) {
      completionStatus = 'error';
      completionError = getErrorMessage(error);
      assistantRecord.text = completionError;
      assistantRecord.error = completionError;
      assistantRecord.status = 'error';
      assistantRecord.timestamp = Date.now();
      await persistChatSnapshot(snapshot.meta, snapshot.stored);
      refreshVisible();
    } finally {
      chatRuns.finish(destinationChatId!, run.id);
      syncRunControls();
      renderChatHistory();
    }
  } catch (error) {
    completionStatus = 'error';
    completionError = getErrorMessage(error);
  }
  await invoke('complete_scheduled_task', {
    taskId: task.id,
    executionId: execution.executionId,
    status: completionStatus,
    error: completionError,
    destinationChatId
  });
  if (destinationChatId === activeSessionId && document.hasFocus()) {
    await markChatRead(destinationChatId, true);
  }
}

async function loadChatBookmarks(chatId: string) {
  const entries = await invoke<StoredBookmark[]>('list_chat_bookmarks', { chatId });
  return new Map(entries.map((entry) => [entry.messageKey, entry]));
}

async function openBookmarkedAnswer(bookmark: StoredBookmark) {
  try {
    await openSavedChat(bookmark.chatId);
    const record = storedMessages.find(
      (message) =>
        message.role === 'assistant' && bookmarkMessageKey(message) === bookmark.messageKey
    );
    const article = record ? renderedMessageArticles.get(record) : undefined;
    article?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    article?.classList.add('bookmark-target');
    if (article) window.setTimeout(() => article.classList.remove('bookmark-target'), 1200);
  } catch (error) {
    if (chatHistoryStatus && sidebarView === 'bookmarks') {
      chatHistoryStatus.textContent = getErrorMessage(error, 'Could not open bookmarked chat.');
    }
  }
}

function renderChatHistory() {
  if (!chatHistoryList) return;
  chatHistoryList.innerHTML = '';

  const filteredChats = filterChatsByName(chatHistoryRows, chatSearchInput?.value ?? '');
  for (const chat of filteredChats) {
    const row = document.createElement('div');
    row.className = `chat-history-row${chat.chatId === activeSessionId ? ' is-active' : ''}${
      chat.unread ? ' is-unread' : ''
    }`;

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'chat-history-open';
    openButton.setAttribute(
      'aria-label',
      `${chat.name}${chat.unread ? ', unread scheduled task result' : ''}`
    );
    const running = chatRuns.get(chat.chatId);
    openButton.innerHTML = `
      <span class="chat-history-title">
        <span class="chat-history-title-text">${escapeHtml(chat.name)}</span>
        ${chat.unread ? '<span class="chat-history-unread-dot" title="Unread scheduled task result"></span>' : ''}
      </span>
      <span class="chat-history-meta">${formatChatDate(chat.updatedAt)} · ${chat.messageCount} messages${running ? ` · ${running.kind === 'builder' ? 'Building' : running.kind === 'scheduled' ? 'Scheduled task' : 'Thinking'}` : ''}</span>
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

  if (chatHistoryStatus && sidebarView === 'chats') {
    chatHistoryStatus.textContent = sidebarStatusText('chats');
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
  await persistChatSnapshot(meta, storedMessages);
}

// Persist a specific chat's snapshot (meta + messages) regardless of which chat
// is currently on screen. A running turn captures its own meta/messages so that
// navigating to another chat mid-run cannot redirect the save to the wrong chat.
async function persistChatSnapshot(meta: ChatMeta | undefined, stored: StoredChatMessage[]) {
  if (!meta || !stored.length) return;
  meta.updatedAt = latestChatTurnIso(stored, meta.updatedAt);
  await chatSnapshotSaves.enqueue(meta.chatId, { ...meta, messages: stored });
}

async function markChatRead(chatId: string, force = false) {
  const existing = chatHistoryRows.find((chat) => chat.chatId === chatId);
  if (!force && !existing?.unread) return;

  const wasUnread = existing?.unread ?? false;
  if (existing) existing.unread = false;
  if (activeChatMeta?.chatId === chatId) activeChatMeta.unread = false;
  renderChatHistory();

  try {
    const updated = await invoke<ChatHistoryRow>('mark_chat_history_read', { chatId });
    const index = chatHistoryRows.findIndex((chat) => chat.chatId === chatId);
    if (index >= 0) chatHistoryRows[index] = updated;
    renderChatHistory();
  } catch (error) {
    if (existing) existing.unread = wasUnread;
    if (activeChatMeta?.chatId === chatId) activeChatMeta.unread = wasUnread;
    renderChatHistory();
    console.error('Could not mark chat as read:', getErrorMessage(error));
  }
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

function createTurnSnapshotPersister(persist: () => void, intervalMs = 1500) {
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
    void markChatRead(chatId);
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
    activeBookmarks = await loadChatBookmarks(chatId).catch(() => new Map());
    if (viewRevision !== mainViewRevision) return;
    bindChatState(liveRun.meta, liveRun.messages);
    void markChatRead(chatId);
    renderStoredTranscript();
    showConversation();
    renderChatHistory();
    syncRunControls();
    chatInput?.focus();
    return;
  }

  const [chat, chatBookmarks] = await Promise.all([
    invoke<ChatHistoryPayload>('read_chat_history', { chatId }),
    loadChatBookmarks(chatId).catch(() => new Map<string, StoredBookmark>())
  ]);
  if (viewRevision !== mainViewRevision) return;
  activeBookmarks = chatBookmarks;
  const recovered = recoverInterruptedMessages(chat.messages);
  const wasUnread = chat.unread;
  bindChatState({
    chatId: chat.chatId,
    name: chat.name,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    unread: false,
    activeBuildPlugin: chat.activeBuildPlugin
  }, recovered.messages);
  if (wasUnread) void markChatRead(chatId, true);
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
  messages.querySelectorAll<HTMLElement>('[data-chart-root]').forEach(unmountChart);
  messages.innerHTML = '';
  for (const message of storedMessages) {
    renderStoredMessage(message);
  }
}

async function deleteSavedChat(chatId: string) {
  if (chatRuns.has(chatId)) return;
  try {
    await invoke('delete_chat_history', { chatId });
  } catch (error) {
    if (chatHistoryStatus) {
      chatHistoryStatus.textContent = getErrorMessage(error, 'Could not delete the chat.');
    }
    return;
  }
  if (chatId === activeSessionId) {
    resetConversationState();
    messages?.replaceChildren();
    shell?.classList.add('pre-chat');
    shell?.classList.remove('plugin-view');
    pluginDetailView?.classList.add('is-hidden');
    settingsToggle?.setAttribute('aria-pressed', 'false');
    messages?.classList.remove('is-hidden');
    chatForm?.classList.remove('is-hidden');
  }
  await refreshChatHistory();
  if (sidebarView === 'bookmarks') await refreshBookmarks(true);
}

/**
 * The "this is a snapshot" line above an imported answer.
 *
 * It matters more than it looks. `renderStoredTranscript` rebuilds
 * `chatMessages` as role/text only, so the model never sees the imported card
 * data — a follow-up like "now break that out by region" runs a *live* query
 * rather than slicing the frozen table. That is the right behaviour, but it has
 * to be said out loud or the numbers could appear to change on their own.
 */
function renderSharedAnswerBanner(article: HTMLElement) {
  article.querySelector<HTMLElement>(':scope > .shared-answer-banner')?.remove();

  const banner = document.createElement('p');
  banner.className = 'shared-answer-banner';
  banner.textContent =
    'Shared answer. The results below are a snapshot — ask a follow-up to run it live.';
  article.prepend(banner);
}

function renderShareImportError(message: string) {
  if (!messages) return;
  const notice = document.createElement('article');
  notice.className = 'message assistant';
  const body = document.createElement('div');
  body.className = 'message-text message-error';
  body.textContent = message;
  notice.appendChild(body);
  messages.appendChild(notice);
}

/**
 * Open a shared answer in a new chat.
 *
 * Viewing needs no credentials and no extensions: the cards render from the
 * data embedded in the link and the citations resolve against it. What the
 * recipient may be missing is the extension needed to ask a *follow-up*, so an
 * uninstalled one is offered through the existing inline install card.
 */
async function openSharedAnswer(encoded: string) {
  // A live turn owns the transcript; importing over it would clobber the run.
  if (chatRuns.has(activeSessionId)) return;

  let payload: SharedAnswerPayload;
  try {
    payload = await decodeSharePayload(encoded);
  } catch (error) {
    showConversation();
    renderShareImportError(getErrorMessage(error, 'This share link could not be read.'));
    return;
  }

  // A cold-start deep link beats the catalog load, and the nudge needs it.
  if (!initialExtensionsLoaded) await refreshGeneratedPlugins();

  await startNewConversation({ showPreChat: false });
  ensureActiveChatMeta(payload.q);

  const { user, assistant } = messagesFromSharedPayload(payload);
  const assistantRecord: StoredChatMessage = { ...assistant, sharedImport: true };
  const recommendation = recommendationForShare(
    payload,
    catalogExtensions.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      installed: entry.installed
    }))
  );
  if (recommendation) assistantRecord.extensionRecommendation = recommendation;

  storedMessages.push(user as StoredChatMessage, assistantRecord);
  renderStoredTranscript();

  // The inline install card is the targeted nudge; the onboarding modal would
  // compete with it for the same decision.
  extensionOnboardingPending = false;

  await persistActiveChatHistory();
  await refreshChatHistory();
}

async function startNewConversation(options: { showPreChat: boolean }) {
  mainViewRevision += 1;
  await persistActiveChatHistory();
  resetConversationState();
  messages?.replaceChildren();
  shell?.classList.remove('plugin-view');
  selectedPluginId = '';
  selectedCatalogExtensionSlug = '';
  renderGeneratedPlugins();
  pluginDetailView?.classList.add('is-hidden');
  settingsToggle?.setAttribute('aria-pressed', 'false');
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
  activeBookmarks = new Map();
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
  if (message.sharedImport) renderSharedAnswerBanner(article);
  if (message.scheduledTaskName) {
    const origin = document.createElement('p');
    origin.className = 'scheduled-message-origin';
    origin.textContent = `Scheduled · ${message.scheduledTaskName}`;
    article.prepend(origin);
  }
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
  if (message.role === 'assistant' && message.extensionRecommendation) {
    renderExtensionRecommendation(article, message.extensionRecommendation);
  }
  if (message.role === 'assistant' && message.scheduledTaskRequest) {
    const body = article.querySelector<HTMLElement>('.message-text');
    if (body) renderScheduledTaskConfirmation(body, message);
  }
  if (message.role === 'assistant' && message.modelFailure) {
    const body = article.querySelector<HTMLElement>('.message-text');
    if (body) renderModelFailure(body, message.modelFailure);
  }
  if (message.role === 'assistant' && message.status !== 'running' && message.charts?.length) {
    renderMessageCharts(article, message.charts, messageContext(message));
  }
  if (message.role === 'assistant' && message.cards?.length) {
    renderMessageCards(article, message.cards);
  }
  // Returning to a chat whose turn is still running: restore the liveness row so
  // a backgrounded run does not look like it was dropped.
  if (message.role === 'assistant' && !message.builderRun && message.status === 'running') {
    const kind = chatRuns.get(activeSessionId)?.kind;
    const live = kind === 'agent' || kind === 'scheduled';
    setAgentActivity(article, agentActivityLabel({ running: live, streaming: false }));
  }
  syncMessageActions(article, message);
}

function renderScheduledTaskConfirmation(body: HTMLElement, record: StoredChatMessage) {
  const request = record.scheduledTaskRequest;
  if (!request) return;
  if (record.scheduledTaskId) {
    const created = scheduledTasks.find((entry) => entry.id === record.scheduledTaskId);
    body.replaceChildren();
    const panel = document.createElement('section');
    panel.className = 'scheduled-task-created';
    const icon = document.createElement('span');
    icon.className = 'scheduled-task-created-icon';
    icon.innerHTML = iconSvg('stopwatch');
    const copy = document.createElement('div');
    copy.className = 'scheduled-task-created-copy';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'scheduled-task-created-eyebrow';
    eyebrow.textContent = 'Scheduled task created';
    const title = document.createElement('strong');
    title.textContent = request.name;
    const frequency = request.schedule.frequency;
    const parts = [
      `${frequency[0].toUpperCase()}${frequency.slice(1)} at ${request.schedule.time}`,
      request.destinationType === 'newChat' ? 'dedicated chat' : 'this chat'
    ];
    if (created?.enabled) parts.push(`next ${formatChatDate(created.nextRunAt)}`);
    const summary = document.createElement('span');
    summary.className = 'scheduled-task-created-summary';
    summary.textContent = parts.join(' · ');
    copy.append(eyebrow, title, summary);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'scheduled-task-created-open';
    open.textContent = 'Open';
    open.addEventListener('click', async () => {
      await refreshScheduledTasks();
      const task = scheduledTasks.find((entry) => entry.id === record.scheduledTaskId);
      if (task) {
        setSidebarView('scheduled');
        openScheduledTask(task);
      }
    });
    panel.append(icon, copy, open);
    body.appendChild(panel);
    return;
  }

  const panel = document.createElement('section');
  panel.className = 'capability-confirmation scheduled-task-confirmation';
  const title = document.createElement('h3');
  title.textContent = 'Create scheduled task?';
  const hint = document.createElement('p');
  hint.textContent = 'Review the recurring prompt and schedule. Nothing is saved until you confirm.';
  const editor = document.createElement('div');
  panel.append(title, hint);
  // The panel replaces the assistant's text, so a schedule the agent had to
  // approximate would otherwise be applied silently.
  if (request.scheduleNote) {
    const note = document.createElement('p');
    note.className = 'scheduled-task-note';
    note.textContent = request.scheduleNote;
    panel.append(note);
  }
  panel.append(editor);
  body.replaceChildren(panel);
  renderTaskEditor(editor, request, {
    submitLabel: 'Create task',
    onSubmit: async (draft, status) => {
      await persistActiveChatHistory();
      const task = await invoke<ScheduledTask>('create_scheduled_task', { draft });
      record.scheduledTaskRequest = draft;
      record.scheduledTaskId = task.id;
      record.text = `Scheduled: ${task.name}`;
      record.status = 'completed';
      await persistActiveChatHistory();
      await refreshScheduledTasks();
      status.textContent = 'Created.';
      renderScheduledTaskConfirmation(body, record);
    }
  });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'capability-secondary-action scheduled-task-dismiss';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', async () => {
    record.scheduledTaskRequest = undefined;
    record.text = 'Canceled scheduled task. Nothing was created.';
    body.textContent = record.text;
    await persistActiveChatHistory();
  });
  panel.querySelector('.task-editor-buttons')?.prepend(dismiss);
}

function syncMessageActions(article: HTMLElement, message: StoredChatMessage) {
  const existing = article.querySelector<HTMLElement>(':scope > .message-actions');
  if (message.scheduledTaskRequest || !canBookmarkMessage(message)) {
    existing?.remove();
    return;
  }

  let actions = existing;
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'message-actions';
    article.appendChild(actions);
  }

  let bookmark = actions.querySelector<HTMLButtonElement>('[data-action="bookmark"]');
  if (!bookmark) {
    bookmark = document.createElement('button');
    bookmark.type = 'button';
    bookmark.dataset.action = 'bookmark';
    bookmark.innerHTML = iconSvg('bookmark');
    bookmark.addEventListener('click', () => void toggleMessageBookmark(article, message, bookmark!));
    actions.appendChild(bookmark);
  }
  const bookmarked = activeBookmarks.has(bookmarkMessageKey(message));
  bookmark.classList.toggle('is-bookmarked', bookmarked);
  bookmark.setAttribute('aria-pressed', String(bookmarked));
  bookmark.setAttribute('aria-label', bookmarked ? 'Remove bookmark' : 'Bookmark this response');
  bookmark.title = bookmarked ? 'Remove bookmark' : 'Bookmark this response';

  // Sharing is a narrower gate than bookmarking: a builder transcript can be
  // bookmarked but has no answer to send anyone.
  const share = actions.querySelector<HTMLButtonElement>('[data-action="share"]');
  if (!canShareMessage(message)) {
    share?.remove();
    return;
  }
  if (!share) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'share';
    button.innerHTML = iconSvg('share-2');
    button.setAttribute('aria-label', 'Share this response');
    button.title = 'Share this response';
    button.addEventListener('click', () => shareMessage(message));
    actions.appendChild(button);
  }
}

/**
 * Name the extensions behind an answer's cards.
 *
 * A bundled catalog extension carries a slug, which is what lets a recipient
 * install it. A user-built plugin has none, so it is named but not offered —
 * there is nothing on the recipient's machine to install it from.
 */
function shareExtensionsForCards(cards: StoredResultCard[]): ShareExtension[] {
  const extensions: ShareExtension[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    const catalog = catalogExtensions.find((entry) =>
      entry.tools.some((tool) => tool.name === card.toolName)
    );
    if (catalog) {
      if (seen.has(catalog.slug)) continue;
      seen.add(catalog.slug);
      extensions.push({
        slug: catalog.slug,
        name: catalog.name,
        description: catalog.description
      });
      continue;
    }

    const local = pluginNameForTool(card.toolName);
    if (local && !seen.has(local)) {
      seen.add(local);
      extensions.push({ name: local });
    }
  }

  return extensions;
}

function shareMessage(message: StoredChatMessage) {
  openShareModal({
    question: promptForAssistant(storedMessages, message),
    message: {
      text: message.text,
      cards: message.cards && withPluginNames(message.cards),
      charts: message.charts,
      sources: message.sources
    },
    extensions: shareExtensionsForCards(message.cards ?? []),
    loadArtifact: resultArtifactLoader,
    baseUrl: SHARE_BASE_URL,
    copy: (text) => writeClipboard({ text }),
    openExternal: async (url) => {
      await invoke('open_external_url', { url });
    }
  });
}

async function toggleMessageBookmark(
  article: HTMLElement,
  message: StoredChatMessage,
  button: HTMLButtonElement
) {
  const messageKey = bookmarkMessageKey(message);
  const chatId = activeSessionId;
  const chatName = activeChatMeta.name;
  const chatBookmarks = activeBookmarks;
  const chatStoredMessages = storedMessages;
  const existing = chatBookmarks.get(messageKey);
  button.disabled = true;
  try {
    if (existing) {
      await invoke('delete_bookmark', { chatId, messageKey });
      chatBookmarks.delete(messageKey);
    } else {
      const prompt = promptForAssistant(chatStoredMessages, message);
      if (!prompt) throw new Error('Could not find the prompt for this response.');
      const bookmark = await invoke<StoredBookmark>('save_bookmark', {
        bookmark: {
          id: `${chatId}:${messageKey}`,
          messageKey,
          chatId,
          chatName,
          prompt,
          answer: message.text,
          messageTimestamp: message.timestamp,
          createdAt: Date.now()
        } satisfies StoredBookmark
      });
      chatBookmarks.set(messageKey, bookmark);
    }
    if (activeSessionId === chatId && activeBookmarks === chatBookmarks) {
      syncMessageActions(article, message);
    }
    if (sidebarView === 'bookmarks') await refreshBookmarks(true);
  } catch (error) {
    button.title = getErrorMessage(error, 'Could not update bookmark.');
  } finally {
    button.disabled = false;
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
  renderResultCards(ensureCardContainer(article), withPluginNames(cards));
}

/** The display name of the plugin that owns a runtime tool, for citations. */
function pluginNameForTool(toolName: string): string | undefined {
  return generatedPlugins.find((plugin) => plugin.tools.some((tool) => tool.name === toolName))
    ?.name;
}

/**
 * Name the owning extension on cards persisted before they carried one, so an
 * older chat still gets a per-source summary. A card whose extension is no
 * longer installed stays unattributed and falls back to the per-kind label.
 */
function withPluginNames(cards: StoredResultCard[]): StoredResultCard[] {
  return cards.map((card) =>
    card.plugin ? card : { ...card, plugin: pluginNameForTool(card.toolName) }
  );
}

/** Pull a storable result card out of a tool-result event, if the tool has one. */
function extractResultCard(
  event: { toolName: string; result: unknown },
  pluginName?: string
): StoredResultCard | null {
  const result = event.result;
  if (!result || typeof result !== 'object') return null;
  const card = (result as Record<string, unknown>).card;
  if (!card || typeof card !== 'object' || !Array.isArray((card as Record<string, unknown>).layout)) {
    return null;
  }
  const rawArtifact = (result as Record<string, unknown>).dataArtifact;
  const artifact =
    rawArtifact && typeof rawArtifact === 'object'
      ? (rawArtifact as Record<string, unknown>)
      : null;
  return {
    toolName: event.toolName,
    plugin: pluginName || undefined,
    template: card as StoredResultCard['template'],
    data: (result as Record<string, unknown>).data ?? {},
    cached: resultWasCached(result) || undefined,
    artifact:
      artifact &&
      typeof artifact.chatId === 'string' &&
      typeof artifact.artifactId === 'string' &&
      typeof artifact.byteCount === 'number'
        ? {
            chatId: artifact.chatId,
            artifactId: artifact.artifactId,
            byteCount: artifact.byteCount
          }
        : undefined
  };
}

/**
 * Sends the composer's contents.
 *
 * With no run in flight this starts an ordinary turn. With one running, the
 * message is queued for the working agent instead: `steer` reaches it at the
 * next tool-round boundary, `followUp` waits until it would otherwise stop.
 */
async function submitMessage(
  input: HTMLTextAreaElement | null,
  delivery: SteerDelivery = 'steer'
) {
  if (!input || !messages) return;

  const content = input.value.trim();
  if (!content) return;
  // Slash commands are host commands, not messages, so they still run locally
  // while the agent is working.
  if (await runSlashCommand(content, input)) return;

  const run = chatRuns.get(activeSessionId);
  if (run) {
    // A builder run has no steering channel, and a run without a stream id has
    // not reached its sidecar yet.
    if (run.kind !== 'agent' || !run.streamId) return;
    input.value = '';
    chatRuns.enqueue(run.chatId, run.id, { text: content, delivery });
    renderPendingQueue();
    void logAgentTurnEvent('steer_queued', { text: content, delivery }, run.chatId);
    try {
      await steerAgentTurn(run.streamId, content, delivery);
      return;
    } catch (error) {
      chatRuns.dequeueText(run.chatId, run.id, content);
      renderPendingQueue();
      // The turn ended between typing and sending. Ask it as an ordinary new
      // question rather than dropping the message.
      if (chatRuns.has(activeSessionId)) {
        input.value = content;
        console.error('Could not steer the agent:', getErrorMessage(error));
        return;
      }
    }
  }

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

  // Re-assignable: a steering message ends the current assistant bubble and
  // opens a new one, so a turn can own several segments.
  let pending = addMessage('assistant', '', true);
  let pendingBody = pending.querySelector<HTMLElement>('.message-text');
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
  let assistantRecord: StoredChatMessage = {
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
    let requestedSchedule: ScheduledTaskRequest | undefined;
    let requestedCredential: CredentialRequest | undefined;
    let recommendedExtension: ExtensionRecommendation | undefined;
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
        snapshotPersister.schedule();
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
        const chart = extractPresentedChart(toolCall.result);
        if (chart) {
          (assistantRecord.charts ??= []).push(chart);
        }
        const pluginName = pluginNameForTool(toolCall.toolName);
        const resultCard = extractResultCard(toolCall, pluginName);
        let cardIndex: number | undefined;
        if (resultCard) {
          cardIndex = (assistantRecord.cards ??= []).push(resultCard) - 1;
          if (turnIsActive()) renderMessageCards(pending, assistantRecord.cards);
        }
        const source = extractToolSource(toolCall.result, toolCall.toolName, pluginName);
        // A citation opens the card this same call rendered.
        if (source && cardIndex !== undefined) source.cardIndex = cardIndex;
        if (source) (assistantRecord.sources ??= []).push(source);
        snapshotPersister.schedule();
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
      onScheduledTaskRequest: (request) => {
        requestedSchedule = request;
        void logAgentTurnEvent('scheduled_task_request', { request }, turnSessionId);
      },
      onCredentialRequest: (request) => {
        requestedCredential = request;
        void logAgentTurnEvent('credential_request', { request, mode: turnMode }, turnSessionId);
      },
      onExtensionRecommendation: (recommendation) => {
        recommendedExtension = recommendation;
        void logAgentTurnEvent(
          'extension_recommendation',
          { recommendation, mode: turnMode },
          turnSessionId
        );
      },
      /**
       * A message the user typed mid-run just entered the agent's transcript.
       *
       * What the assistant had written until now is final, the steer becomes a
       * real user bubble, and everything after it is a new assistant message.
       * This is not only cosmetic: the sidecar's final text is the LAST
       * assistant message alone, so without a record per segment the completion
       * path below would overwrite everything written before the steer.
       */
      onSteeringApplied: (text) => {
        if (settled) return;
        chatRuns.dequeueText(turnSessionId, run.id, text);
        renderPendingQueue();

        const finishedText = streamed.trim();
        assistantRecord.text = finishedText || 'Steered before this answer started.';
        assistantRecord.thinking = thinking.trim() || undefined;
        assistantRecord.status = 'completed';
        assistantRecord.error = undefined;
        assistantRecord.timestamp = Date.now();
        if (turnIsActive()) {
          // Model-visible history is written on the active path only, matching
          // the completion path below; a backgrounded turn already skips it.
          if (finishedText) {
            turnChatMessages.push({ role: 'assistant', content: finishedText });
          }
          if (thinkingPreview.parentElement) thinkingPreview.remove();
          if (pendingBody) {
            renderMessageText(
              pendingBody,
              assistantRecord.text,
              true,
              messageContext(assistantRecord)
            );
          }
          renderMessageCharts(pending, assistantRecord.charts, messageContext(assistantRecord));
          pending.classList.remove('pending');
          syncMessageActions(pending, assistantRecord);
        }

        const steerRecord: StoredChatMessage = {
          role: 'user',
          text,
          timestamp: Date.now()
        };
        turnStored.push(steerRecord);
        if (turnIsActive()) turnChatMessages.push({ role: 'user', content: text });

        assistantRecord = {
          role: 'assistant',
          text: 'Thinking...',
          timestamp: Date.now(),
          status: 'running'
        };
        turnStored.push(assistantRecord);
        streamed = '';
        thinking = '';
        activeToolName = undefined;
        if (turnIsActive()) {
          const steerArticle = addMessage('user', text);
          renderedMessageArticles.set(steerRecord, steerArticle);
          pending = addMessage('assistant', '', true);
          pendingBody = pending.querySelector<HTMLElement>('.message-text');
          renderedMessageArticles.set(assistantRecord, pending);
          scrollMessagesToBottom();
        }
        refreshActivity();
        snapshotPersister.schedule(true);
        syncRemountedTurn();
        void logAgentTurnEvent('steer_applied', { text }, turnSessionId);
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
    }, turnSessionId);
    settled = true;
    if (thinkingPreview.parentElement) {
      thinkingPreview.remove();
    }

    requestedSchedule = reply.scheduledTaskRequest ?? requestedSchedule;
    if (requestedSchedule) {
      assistantRecord.text = `Review scheduled task: ${requestedSchedule.name}`;
      assistantRecord.thinking = thinking.trim() || undefined;
      assistantRecord.status = 'completed';
      assistantRecord.scheduledTaskRequest = requestedSchedule;
      assistantRecord.error = undefined;
      if (turnIsActive() && pendingBody) {
        pending.classList.remove('pending');
        renderScheduledTaskConfirmation(pendingBody, assistantRecord);
        turnChatMessages.push({ role: 'assistant', content: assistantRecord.text });
      }
      await persistChatSnapshot(turnMeta, turnStored);
      await refreshChatHistory();
      syncRemountedTurn();
      return;
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

    recommendedExtension = reply.extensionRecommendation ?? recommendedExtension;

    const finalContent = reply.content || streamed || 'The model returned an empty response.';
    if (turnIsActive()) {
      if (pendingBody) {
        renderMessageText(pendingBody, finalContent, true, messageContext(assistantRecord));
      }
      renderMessageCharts(pending, assistantRecord.charts, messageContext(assistantRecord));
      pending.classList.remove('pending');
      if (recommendedExtension) {
        renderExtensionRecommendation(pending, recommendedExtension);
      }
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
    assistantRecord.extensionRecommendation = recommendedExtension;
    await persistChatSnapshot(turnMeta, turnStored);
    if (turnIsActive()) syncMessageActions(pending, assistantRecord);
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
    restoreQueuedToComposer(run);
    chatRuns.finish(turnSessionId, run.id);
    syncRunControls();
    renderChatHistory();
    if (activeSessionId === turnSessionId) chatInput?.focus();
  }
}

function syncRunControls() {
  const run = chatRuns.get(activeSessionId);
  const visible = Boolean(run);
  // The composer stays live through an agent run: typing into it is how the
  // agent is steered. A builder run has no steering channel, so it keeps the
  // old lock.
  if (chatInput) chatInput.disabled = run?.kind === 'builder' || run?.kind === 'scheduled';
  renderPendingQueue();
  if (!stopStreamButton) return;
  stopStreamButton.classList.toggle('is-hidden', !visible);
  stopStreamButton.disabled = !run?.streamId;
  stopStreamButton.textContent = run?.streamId ? 'Stop' : 'Starting';
}

/**
 * The dim strip above the composer listing messages the agent has not taken yet.
 *
 * Queued text deliberately stays out of the transcript until the agent actually
 * receives it, so the transcript never shows a message the model never saw.
 */
function renderPendingQueue() {
  if (!pendingQueue) return;
  const queued = chatRuns.get(activeSessionId)?.queued ?? [];
  pendingQueue.replaceChildren();
  pendingQueue.classList.toggle('is-hidden', queued.length === 0);
  for (const entry of queued) {
    const row = document.createElement('div');
    row.className = 'pending-queue-row';
    const label = document.createElement('span');
    label.className = 'pending-queue-label';
    label.textContent = entry.delivery === 'followUp' ? 'Follow-up' : 'Steering';
    const text = document.createElement('span');
    text.className = 'pending-queue-text';
    text.textContent = entry.text;
    row.append(label, text);
    pendingQueue.appendChild(row);
  }
}

/**
 * Hands text the agent never received back to the composer.
 *
 * Losing what somebody typed because the turn stopped first is worse than
 * making them press Enter again.
 */
function restoreQueuedToComposer(run: ChatRun<ChatMeta, StoredChatMessage>) {
  const queued = chatRuns.takeQueued(run.chatId, run.id);
  renderPendingQueue();
  if (!queued.length || run.chatId !== activeSessionId || !chatInput) return;
  chatInput.value = [...queued.map((entry) => entry.text), chatInput.value]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n');
  chatInput.focus();
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
      renderMessageCharts(article, record.charts, messageContext(record));
      if (record.cards?.length) renderMessageCards(article, record.cards);
      if (record.extensionRecommendation) {
        renderExtensionRecommendation(article, record.extensionRecommendation);
      }
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

/** Inline action for an extension the main agent found in the bundled catalog. */
function renderExtensionRecommendation(
  article: HTMLElement,
  recommendation: ExtensionRecommendation
) {
  article
    .querySelector<HTMLElement>(':scope > .extension-recommendation')
    ?.remove();

  const extension = catalogExtensions.find(
    (candidate) => candidate.slug === recommendation.slug
  );
  const panel = document.createElement('section');
  panel.className = 'extension-recommendation';

  const copy = document.createElement('div');
  copy.className = 'extension-recommendation-copy';
  const name = document.createElement('strong');
  name.textContent = recommendation.name;
  copy.appendChild(name);
  if (recommendation.description) {
    const description = document.createElement('span');
    description.textContent = recommendation.description;
    copy.appendChild(description);
  }

  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'extensions-install-button extension-recommendation-install';
  install.textContent = extension?.installed
    ? 'Installed'
    : `Install ${recommendation.name}`;
  install.disabled = extension?.installed === true;

  const status = document.createElement('span');
  status.className = 'extension-recommendation-status';
  status.setAttribute('aria-live', 'polite');

  install.addEventListener('click', () => {
    if (install.disabled) return;
    install.disabled = true;
    install.textContent = 'Installing...';
    status.textContent = '';
    void (async () => {
      try {
        await invoke<GeneratedPlugin>('install_catalog_extension', {
          slug: recommendation.slug
        });
        await refreshGeneratedPlugins();
        install.textContent = 'Installed';
        status.textContent = `${recommendation.name} is ready. Ask your question again to use it.`;
      } catch (error) {
        install.disabled = false;
        install.textContent = `Install ${recommendation.name}`;
        status.textContent = getErrorMessage(
          error,
          `Could not install ${recommendation.name}.`
        );
      }
    })();
  });

  panel.append(copy, install, status);
  article.appendChild(panel);
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
    if (turnIsActive() && builderRecord) {
      const article = body.closest<HTMLElement>('article.message');
      if (article) {
        renderedMessageArticles.set(builderRecord, article);
        syncMessageActions(article, builderRecord);
      }
    }
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
    reconcileBuilderTimeline(
      timeline,
      projectBuilderTimeline(activities),
      live && message.status === 'running'
    );
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
  activities: BuilderTimelineSlot[],
  live: boolean
) {
  const existingIds = Array.from(timeline.children).map(
    (child) => (child as HTMLElement).dataset.toolCallId || ''
  );
  const { ops, length } = planBuilderTimeline(existingIds, activities);
  for (const op of ops) {
    const activity = activities[op.index];
    const existing = timeline.children[op.index] as HTMLElement | undefined;
    if (isToolSummaryActivity(activity)) {
      if (op.action === 'reuse' && existing) {
        updateBuilderToolSummaryCard(existing as HTMLDetailsElement, activity);
      } else {
        timeline.insertBefore(
          renderBuilderToolSummaryCard(activity),
          timeline.children[op.index] ?? null
        );
      }
      continue;
    }
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
  const icon = document.createElement('span');
  icon.className = 'builder-tool-icon';
  summary.appendChild(icon);
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

// A finished, successful call fades from a full card down to one quiet line —
// same treatment as the reasoning/status entries around it — so only what's
// actively running or actually failed still reads as a card competing for
// attention. Clicking it still opens the full arguments/output for debugging.
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

  const icon = details.querySelector('.builder-tool-icon');
  const iconGlyph =
    activity.status === 'complete' ? '✓' : activity.status === 'error' ? '✕' : '';
  if (icon && icon.textContent !== iconGlyph) icon.textContent = iconGlyph;
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
  // The icon already says "done" for a completed call, so the word would be redundant.
  const statusText = activity.status === 'complete' ? '' : activity.status;
  if (status && status.textContent !== statusText) status.textContent = statusText;

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

// One persistent counter for every finished, successful tool call, instead of
// a new quiet line per call. It stays at the position where the first call
// completed and just updates its count as more land, so a long build doesn't
// scroll the transcript out from under whatever's actively running. Expanding
// it lists each finished call as the same quiet line, still individually
// expandable for its arguments/output.
function renderBuilderToolSummaryCard(activity: BuilderToolSummaryActivity) {
  const details = document.createElement('details');
  details.className = 'builder-tool-summary';
  details.dataset.toolCallId = activity.toolCallId;

  const summary = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'builder-tool-icon';
  icon.textContent = '✓';
  summary.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'builder-tool-summary-label';
  summary.appendChild(label);
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'builder-tool-summary-body';
  details.appendChild(body);

  updateBuilderToolSummaryCard(details, activity);
  return details;
}

function updateBuilderToolSummaryCard(
  details: HTMLDetailsElement,
  activity: BuilderToolSummaryActivity
) {
  const label = details.querySelector('.builder-tool-summary-label');
  const labelText = `${activity.count} tool call${activity.count === 1 ? '' : 's'}`;
  if (label && label.textContent !== labelText) label.textContent = labelText;

  const body = details.querySelector<HTMLElement>('.builder-tool-summary-body');
  if (!body) return;
  // Each entry is terminal once folded in here, so only the newly arrived
  // ones need a card — nothing already rendered ever changes again.
  while (body.children.length < activity.entries.length) {
    const entry = activity.entries[body.children.length];
    body.appendChild(renderBuilderToolCard(entry));
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
  if (activeScheduledTaskId) {
    activeScheduledTaskId = null;
    renderScheduledTasks();
  }
  selectedPluginId = '';
  selectedCatalogExtensionSlug = '';
  renderGeneratedPlugins();
  pluginDetailView?.classList.add('is-hidden');
  settingsToggle?.setAttribute('aria-pressed', 'false');
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
  const sourceText = normalizeChartFenceBoundaries(String(text || ''));
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

/** Mount one already-validated chart and its source line into a message block. */
function appendRenderedChart(
  container: HTMLElement,
  spec: ChartSpec,
  context: MessageContext,
  suppressFallbackCitation = false,
  fallbackSourceEntries?: string[]
) {
  const plotted = spec.sources ?? [];
  const chartEntries = plotted.length
    ? chartSourceEntries(context.sources, plotted)
    : fallbackSourceEntries ?? chartSourceEntries(context.sources, []);
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
  else appendCitationLine(container, context, suppressFallbackCitation);
  renderChart(chart, spec);
}

/**
 * Structured present_chart results live outside the Markdown string. Rebuild
 * their blocks after every streamed/final re-render and after chat reload.
 */
function renderMessageCharts(
  article: HTMLElement,
  charts: ChartSpec[] | undefined,
  context: MessageContext
) {
  const body = article.querySelector<HTMLElement>(':scope > .message-text');
  if (!body) return;
  body.querySelectorAll<HTMLElement>(':scope > [data-presented-chart]').forEach((block) => {
    block.querySelectorAll<HTMLElement>('[data-chart-root]').forEach(unmountChart);
    block.remove();
  });
  for (const spec of normalizeStoredCharts(charts)) {
    const block = document.createElement('div');
    block.dataset.presentedChart = 'true';
    appendRenderedChart(block, spec, context);
    body.appendChild(block);
  }
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
      // A ```chart fence carries a JSON spec the host draws with Recharts.
      // Some models (observed with Kimi) emit the same JSON without labelling
      // the fence ```chart, so any fence body is tried against the chart
      // schema regardless of its language tag. An unparseable spec falls
      // through to the ordinary code block below so the model's output is
      // never swallowed.
      const spec = parseChartSpec(block.join('\n'));
      if (spec) {
        // Legacy saved answers may still contain chart fences. New answers
        // arrive through present_chart and render outside the Markdown text.
        appendRenderedChart(container, spec, context, citedInline, sourceEntries);
        continue;
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
      const tableWrapper = wrapCopyable(table, 'Copy table', () => ({
        text: tableMarkdown,
        image: () => tableToPngBlob(table, sourceEntries)
      }));
      // A wide table (many columns, or long cell text) scrolls horizontally
      // rather than squeezing every column unreadably into the message width.
      tableWrapper.classList.add('copyable-table');
      container.appendChild(tableWrapper);
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
