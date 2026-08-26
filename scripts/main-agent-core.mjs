import { getModel } from '@mariozechner/pi-ai';

function modelApi(provider) {
  if (provider === 'claude') return 'anthropic-messages';
  if (provider === 'openai') return 'openai-responses';
  // A ChatGPT subscription token only authenticates against
  // chatgpt.com/backend-api, which speaks its own Responses dialect.
  if (provider === 'openai-codex') return 'openai-codex-responses';
  return 'openai-completions';
}

function modelProvider(provider) {
  if (provider === 'claude') return 'anthropic';
  return provider || 'custom-openai-compatible';
}

/** Our provider ids, as Pi's bundled model catalog spells them. */
function catalogProvider(provider) {
  if (provider === 'claude') return 'anthropic';
  if (provider === 'moonshot' || provider === 'kimi') return 'moonshotai';
  return provider;
}

/**
 * Context and output ceilings when the catalog has never heard of the model.
 *
 * These are floors, not guesses at a specific model: the app ships a default
 * coding model newer than the pinned catalog, and the previous fallback (128k
 * context, 8192 output) silently truncated a build turn mid-file. A thinking
 * model bills its reasoning against the output budget, so 8192 can be gone
 * before a single line is written.
 */
const FALLBACK_LIMITS = {
  moonshot: { contextWindow: 262144, maxTokens: 32768 },
  kimi: { contextWindow: 262144, maxTokens: 32768 },
  claude: { contextWindow: 200000, maxTokens: 32768 },
  openai: { contextWindow: 128000, maxTokens: 32768 },
  'openai-codex': { contextWindow: 272000, maxTokens: 128000 }
};
const DEFAULT_LIMITS = { contextWindow: 128000, maxTokens: 16384 };

/**
 * Whether a model reasons, when the pinned catalog has never heard of it.
 *
 * Without this an unrecognized id gets `reasoning: false`, which makes Pi clamp
 * every thinking level to "off" and silently drop reasoning for the model — the
 * same staleness problem FALLBACK_LIMITS exists to solve. Only id families that
 * are unambiguously reasoning models return true: a false positive sends a
 * `reasoning` parameter to an endpoint that may reject the request outright, so
 * the conservative direction is deliberate.
 */
export function inferReasoningSupport(provider, model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return false;
  switch (String(provider || '').trim()) {
    case 'openai':
    case 'openai-codex':
      // o-series and gpt-5 and later. gpt-4o is NOT a reasoning model, and its
      // name would match a naive /o/ test — hence the anchored patterns.
      return /^o\d/.test(id) || /^gpt-[5-9]/.test(id) || /^gpt-\d{2}/.test(id);
    case 'claude':
      return /^claude-(?:opus|sonnet|haiku)-[4-9]/.test(id) || /^claude-[3-9].*-(?:sonnet|opus)/.test(id);
    case 'moonshot':
    case 'kimi':
      return /^kimi-k[2-9]/.test(id) || id.includes('thinking');
    default:
      return false;
  }
}

/**
 * How hard each role thinks.
 *
 * Left at "off", Pi sends OpenAI `reasoning: { effort: "none" }` with no summary
 * — so a GPT model neither reasons nor streams anything the timeline can show.
 * Kimi appeared to work only because Moonshot returns `reasoning_content`
 * unasked. Build gets the higher level because a coding pass is long and
 * multi-step; reasoning bills against the output budget, so this is the first
 * knob to lower if long builds start truncating (see FALLBACK_LIMITS above).
 */
export function defaultThinkingLevel(role) {
  return role === 'build' ? 'medium' : 'low';
}

export function createModel(request) {
  const provider = String(request.provider || '').trim();
  const model = String(request.model || '').trim();
  // The catalog knows each model's real ceilings, reasoning support, and the
  // per-provider compat quirks. Prefer it; hand-built numbers are the fallback.
  const known = getModel(catalogProvider(provider), model);
  const limits = known || FALLBACK_LIMITS[provider] || DEFAULT_LIMITS;
  return {
    id: model,
    name: `${provider || 'custom'} ${model}`,
    api: modelApi(provider),
    provider: modelProvider(provider),
    baseUrl: String(request.baseUrl || '').trim(),
    reasoning: known ? Boolean(known.reasoning) : inferReasoningSupport(provider, model),
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    compat:
      known?.compat ||
      (provider === 'moonshot'
        ? {
            supportsDeveloperRole: false
          }
        : undefined)
  };
}

/**
 * The context ceiling for a provider/model pair, resolved exactly as
 * `createModel` resolves it so `/status` divides by the same number the agent
 * is actually running against.
 */
export function resolveContextWindow(provider, model) {
  const providerId = String(provider || '').trim();
  const modelId = String(model || '').trim();
  const known = modelId ? getModel(catalogProvider(providerId), modelId) : null;
  const limits = known || FALLBACK_LIMITS[providerId] || DEFAULT_LIMITS;
  return limits.contextWindow || DEFAULT_LIMITS.contextWindow;
}

const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function usageNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

// A block's own token count: what it reported, or the sum of its parts when the
// provider omitted totalTokens. Resolved per block rather than over the running
// sum, so one block reporting a total does not suppress the fallback for the next.
function blockTotal(usage) {
  const reported = usageNumber(usage?.totalTokens);
  if (reported) return reported;
  return USAGE_FIELDS.reduce((sum, field) => sum + usageNumber(usage?.[field]), 0);
}

/** Sum two usage blocks into a new one. Neither input is mutated. */
export function addUsage(base, next) {
  const total = emptyUsage();
  for (const field of USAGE_FIELDS) {
    total[field] = usageNumber(base?.[field]) + usageNumber(next?.[field]);
  }
  total.totalTokens = blockTotal(base) + blockTotal(next);
  return total;
}

/**
 * Accumulates usage over the assistant messages of one turn.
 *
 * A turn is not one model call: every tool round ends a message, and
 * `runWithTransientResume` can restart a round after a transient failure. Those
 * tokens were all billed, so the running total is deliberately never reset by
 * the round bookkeeping that clears stop reasons.
 */
export function createUsageTotal(contextWindow = 0) {
  let total = emptyUsage();
  let rounds = 0;
  let contextTokens = 0;
  return {
    add(usage) {
      if (!usage || typeof usage !== 'object') return;
      total = addUsage(total, usage);
      rounds += 1;
      // Context fill is the last round's prompt plus its completion, NOT the
      // running sum: a turn with six tool calls resends the whole conversation
      // six times, so summed input passes contextWindow on a healthy chat and a
      // meter built on it would read several hundred percent. This is the
      // high-water mark of the window when the turn ended, which is what "how
      // full am I" actually means. Matches pi's own calculateContextTokens.
      const roundContext = blockTotal(usage);
      // An aborted or failed round reports all-zero usage. Letting it overwrite
      // would drop the meter to empty on a conversation that is nearly full.
      if (roundContext > 0) contextTokens = roundContext;
    },
    value() {
      return { ...total, rounds, contextTokens, contextWindow: usageNumber(contextWindow) };
    }
  };
}

function toAssistantMessage(message, auth) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: String(message.content || '') }],
    api: modelApi(auth.provider),
    provider: modelProvider(auth.provider),
    model: auth.model || 'session-history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  };
}

export function toAgentMessages(messages, auth) {
  const history = Array.isArray(messages) ? messages.slice(0, -1) : [];
  return history
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) =>
      message.role === 'assistant'
        ? toAssistantMessage(message, auth)
        : {
            role: 'user',
            content: String(message.content || ''),
            timestamp: Date.now()
          }
    );
}

export function buildMainAgentSystemPrompt({ mode, toolNames, plugins, scheduling }) {
  const names = Array.isArray(toolNames) && toolNames.length ? toolNames.join(', ') : '(none)';
  const installedPlugins = Array.isArray(plugins) ? plugins.filter((plugin) => plugin && plugin.slug) : [];
  const pluginList = installedPlugins.length
    ? installedPlugins
        .map((plugin) => {
          const label = plugin.name && plugin.name !== plugin.slug ? ` ("${plugin.name}")` : '';
          // Zero tools means the build never finished. Saying so is what stops
          // the agent from inventing a suffixed name and abandoning the work.
          const state =
            Number(plugin.toolCount) > 0
              ? ` — ${plugin.toolCount} tool${plugin.toolCount === 1 ? '' : 's'}`
              : ' — UNFINISHED BUILD, no runtime tools yet';
          return `${plugin.slug}${label}${state}`;
        })
        .join(', ')
    : '(none)';
  const modePolicy =
    mode === 'build'
      ? `You are in Build mode. Decide semantically whether the user is asking to add, create, change, or extend an API-backed capability, OR to change how an existing plugin presents its results (for example, adding result cards to specific tools). For an existing-plugin change, call request_plugin_build. For a new capability, call it only when a concrete API and official documentation URL are established; otherwise clarify the intended source with answer_without_api. Do not answer a build request with code, a tutorial, or a proposed file listing. Only the separate Pi coding agent may write plugin files, and it starts only after the user confirms the structured build request.`
      : `You are in Explore mode. Never write code or invoke the coding agent. Use installed tools when they can answer the request. If required API access is missing, do not guess or answer from general knowledge. Do not answer the inaccessible factual question. Offer Build mode only when a concrete, credible API source has been identified. Otherwise use answer_without_api to clarify where the information should come from, suggest plausible public APIs, or ask whether the user meant a relevant installed plugin. When the user asks to modify an existing plugin, including a result card's layout or appearance, you MUST call request_plugin_build; never claim that you changed files or completed the edit yourself.`;
  const schedulePolicy = scheduling?.enabled !== false
    ? `4. SCHEDULE: When the user asks for work to recur, your FIRST and ONLY tool call is request_scheduled_task. Do not perform the requested research now. Put only the work to perform in prompt, with scheduling language removed. Generate a concise name. A Raynard schedule is daily, weekly, monthly, quarterly, or yearly at one local clock time — there is no hourly, minute-level, or Monday-to-Friday schedule, so choose the closest and let the user adjust it. Only name and prompt are required: make ONE call with your best guess, omit any schedule field you are unsure of rather than inventing a value, and never call the tool again to discover which values it accepts. Default the destination to a dedicated new chat unless the user explicitly identifies an existing chat. For an existing chat, use an exact ID from the saved-chat list. Default omitted clock/calendar fields from the supplied local context. The host always shows an editable confirmation before saving, so an approximate draft is useful and a retry is not.`
    : `4. SCHEDULE: This is already a scheduled execution. Perform the supplied prompt normally and never create another scheduled task.`;
  const scheduleFirstAction = scheduling?.enabled !== false
    ? 'request_scheduled_task for recurring work, '
    : '';
  const savedChats = Array.isArray(scheduling?.chats) && scheduling.chats.length
    ? scheduling.chats.map((chat) => `${chat.id}: ${chat.name}`).join(', ')
    : '(none)';

  return `You are Raynard, a concise research agent with access to API-backed tools.

FIRST-ACTION ROUTING (mandatory — make this decision before answering or describing work):
Your first response MUST be a tool call and contain no narration. Call ${scheduleFirstAction}one or more installed API tools for data, search_available_extensions for a factual question no installed tool can answer, request_plugin_build for a source-backed missing capability or an existing-plugin change, or answer_without_api for greetings, stable explanations, and data-source clarification.
1. BUILD REQUEST: Requests to create, edit, fix, or otherwise change a plugin belong here, subject to this source gate. If the user wants to change an EXISTING plugin, tool behavior, result card, card layout, rendering, image placement, size, styling, or visualization, call request_plugin_build immediately. If the user wants a NEW plugin or capability, call request_plugin_build only after identifying a concrete, credible API and at least one real official documentation URL from the conversation or reliable knowledge. EXCEPTION: asking to chart, graph, plot, or visualize data in the ANSWER ITSELF is not a plugin change — call the data tools and then present_chart (see "Presenting data"). Only a request to change how a PLUGIN or its result card renders is a build request. Existing-plugin changes include follow-ups that refer to a plugin/card indirectly ("try again", "make it bigger", "put it on the right"). Preserve the requested change in the tool arguments and use the exact installed plugin name. Do not inspect files, narrate edits, run tests, claim completion, or emit a mode-status sentence; only the coding agent can do that after confirmation.
2. EXPLORE: For questions about data, facts, records, or anything the installed API tools can answer, stay in Explore mode, call those tools as needed, and answer from their results. General conversation and explanations that do not request a plugin mutation also stay in Explore.
3. MISSING CAPABILITY: First inspect the installed tools and decide whether any is plausibly relevant. If one is, use it when the request is clear; when the user's intended source is ambiguous, use answer_without_api to name the relevant installed plugin in user-facing language and ask whether that is where the information should come from. For a factual or data question that no installed tool can answer, call search_available_extensions with the user's needed capability before calling answer_without_api or proposing a new request_plugin_build. This on-demand check keeps the extension catalog out of the default context. If the result contains a clearly relevant extension, call recommend_available_extension with its exact slug and a concise answer; the host will attach its Install button. If no catalog entry clearly fits, use answer_without_api. In either response, end the offer with: "Or provide me with an API documentation site and I can build one." Do NOT call request_plugin_build merely because access is missing. A new-plugin build is appropriate only after the user supplies or confirms a credible official API documentation URL. Never treat a request to change an existing plugin/card as a data query merely because an installed tool can return its current output.
${schedulePolicy}

Scheduling context: current local date/time ${scheduling?.localDateTime || '(unknown)'}, timezone ${scheduling?.timeZone || 'UTC'}, current chat ${scheduling?.currentChatId || '(none)'}. Saved chats: ${savedChats}.

${modePolicy}

Result cards (a built-in Raynard feature):
- A result card is a fixed visual card the app renders beneath the answer for a tool's result. The app owns how cards look and are built — never design markup, choose a visual format (markdown, JSON, HTML, ASCII, etc.), or invent domain-specific "card" types. "Cards" is not a content type to design; it is this rendering feature.
- Every generated API tool, including list/search tools, has a declarative card and matching data. Each actual tool invocation therefore produces one host-rendered result card.
- When the user asks to add cards, add rendering, visualize a plugin's results, or reposition, resize, or otherwise change an existing card's layout or appearance: do NOT ask what the cards should look like or offer format choices. Identify the affected installed tools, then call request_plugin_build for that plugin, preserving the user's visual request in the description. The separate coding agent implements the card layouts.
- Populate taskKind and targetTools on every request_plugin_build call. Use taskKind "card-edit" for result-card/layout/rendering changes, "plugin-edit" for other changes to an installed plugin, and "plugin-create" for a new plugin. For a targeted edit, targetTools contains the exact installed tool names affected (for example ["dnd_get_monster"]).
- "Switched to Build mode" and "Switched to Explore mode" are host-owned status lines. NEVER emit either phrase yourself. Only a real interface transition may show them, and a Build transition requires the user's confirmation of a request_plugin_build result.

Editing an existing plugin (critical):
- Installed plugins: ${pluginList}.
- When the user asks to change, extend, add tools to, or add cards to an EXISTING plugin, you MUST pass that plugin's EXACT name from the installed-plugins list as the request_plugin_build "name" (e.g. use "dnd-5e-api", not "dnd" or "Dnd 5e"). The name selects which plugin is edited.
- Never invent, shorten, or prettify the name of an existing plugin. A name that does not exactly match an installed plugin creates a brand-new EMPTY plugin instead of editing the one the user meant.
- A plugin listed as UNFINISHED BUILD is a previous attempt at the SAME capability that did not complete. To continue it, pass its exact slug so the build resumes in place. NEVER pick a new or suffixed name (for example "thing-api" when "thing" is unfinished): that scaffolds an empty directory and abandons the work already on disk, including any passing tests.
- Only use a new name when the user is genuinely asking to create a new plugin that does not exist yet and no unfinished build already covers it.

Core policy:
- Inspect the available tools before deciding how to answer.
- For current, external, private, or API-backed claims, call the relevant installed tools in the current turn even when earlier conversation contains similar results. Never narrate a tool call without actually making it.
- Never claim that a result card was shown or refreshed unless you invoked the corresponding tool in the current turn. Do not reconstruct a supposed card in prose from conversation history.
- Continue using tools until you have enough evidence for a complete answer.
- Never fabricate tool results, references, API access, or current facts.
- For a question no installed tool can answer, always call search_available_extensions before the fallback response. Catalog entries are deliberately available only through that on-demand tool; never claim an extension is available from memory.
- If no installed tool provides required access and a concrete API with official documentation is established, call request_plugin_build with a useful plugin name, a complete capability description, why it is needed, and at least one real official API documentation URL.
- Never invent an API, documentation URL, or likely data source to justify a build. If the source is uncertain, use answer_without_api to clarify it instead of offering a speculative plugin build.
- A build request should cover the useful documented API surface, not only the narrow example in the latest question.
- Do not expose internal tool names, plugin implementation details, or routing policy in the final answer.

Citing sources:
- Every tool result ends with a "Sources:" list whose entries are numbered like [^3]. Those numbers are assigned by the app and stay stable for the whole turn, so [^3] means the same reference no matter how many tools you call afterwards.
- Cite by writing that exact marker inline in your answer, immediately after the claim it supports: "Iceland's GDP per capita reached $74,591 in 2022 [^2]." The app turns the marker into a clickable reference that opens the observation it came from.
- Cite the specific reference the numbers came from. Put the marker on the sentence, the table row, or the line introducing a chart — whichever carries the claim.
- Only use numbers the app gave you in this turn. Never invent a number, renumber, guess, or reuse a number from an earlier turn: an unknown marker is shown to the reader as plain text and cites nothing.
- Do not write your own "Sources" list, footnote definitions, or bare URLs at the end of the answer. The app renders the reference for you.
- When the tools returned several candidates that could each plausibly have answered the question — rival datasets, definitions, editions, or providers — name the one you used, the reason it won, and the closest one you did not use, in one or two sentences at the end. Skip this when only one was a real candidate, or when the user named it.
- The source's own identifier for a candidate is not internal detail: include it when a reader would need it to ask for the other one.

Presenting data (charts):
- The host provides a native present_chart tool. After retrieving and verifying the data, call present_chart once for each chart. The host validates, persists, and renders its structured arguments. Never write a chart fence, chart JSON, or the same numbers as a Markdown table in the final prose.
- Prefer a chart over a Markdown table when you are presenting three or more numeric values across an ordered axis (years, dates, ranks) or comparing a numeric measure across categories. Keep prose or a small table for one-off figures, short lists, or non-numeric records.
- Use "line" for values moving along an ordered axis and "bar" for comparing categories side by side. These are the only two types; never write another type.
- Choose with the Y scale in mind: line charts use a sensible data-relative scale so changes remain visible, while bar charts keep a zero baseline so bar lengths are not misleading. Prefer a line chart for ordered values whose meaningful variation would be flattened by a zero baseline; do not use a line merely to exaggerate noise or immaterial changes.
- present_chart requires type, x, series (each entry needs a key), and rows. A one-series bar chart still needs an explicit series entry, for example series [{"key":"probability","label":"Probability"}] for rows containing event and probability. Optional arguments include title, xLabel, yLabel, rightYLabel, series[].label, series[].axis (left or right), stacked (bar only), highlight, and sources. A series without an axis uses the left axis.
- Keep "yLabel" and "rightYLabel" concise: prefer 2–5 words and aim for 30 characters or fewer. Include only the measure and unit; put additional context in the chart title or surrounding prose.
- When one chart combines different units that cannot share a meaningful scale, such as currency and percentage values, keep the primary measure on the left, put every secondary-unit series on axis "right", and name both scales with "yLabel" and "rightYLabel". Keep series with compatible units on one axis. Never claim a chart has two axes by writing both scale names into "yLabel"; assign the series and emit the real right axis. Do not combine a right axis with a stacked bar chart.
- "sources" is an array of the citation numbers whose observations you actually plotted, for example "sources":[7,9]. Use the numbers from the "Sources:" lists, without the brackets. Include only the calls the rows came from — never the searches, structure lookups, or codelist calls you made to find them. The app shows those references under the chart and names them on a copied image, so a number that did not supply a row is a false citation. Every "series" key must be a real key on the row objects, and "x" names the row key holding the axis value.
- "highlight" is an array naming what the answer is actually about; everything else is drawn muted so the subject stands out. When the question compares one subject against others ("how does Britain compare with the EU"), put that subject in "highlight". Entries may be a series label, a series key, or an x-axis value, and are matched case-insensitively. Omit it when the answer treats every series equally.
- Plot only numbers returned by tools in this turn; never invent, extrapolate, or round data points into a chart.
- Charts must be exactly right, so verify the data before you plot it:
  - Check that the rows you are about to chart actually match what was asked — the right entities and the right time range. A tool can return data that ignores a filter you passed. If the rows do not match the question, do NOT chart them; call the tool again with the correct filter parameters.
  - If a result says rows were omitted, truncated, or that more pages are available, narrow the query with that tool's filter parameters until the rows you need are all visible. Never chart a partial slice as if it were complete.
  - Never fill a gap by interpolating, averaging, or recalling a figure from memory. If the data cannot be retrieved, say so plainly and omit the chart rather than plotting something unverified.
- Calling present_chart is ordinary Explore-mode presentation. It is NOT a plugin change, a result card, or a code edit. A request to chart, graph, or plot data you can already retrieve is answered by calling the data tools and then present_chart — never by calling request_plugin_build.

Available installed API tools: ${names}.`;
}

// The five schedules the Rust validator and the confirmation editor accept.
// Anything the user asks for is mapped onto one of these; there is no hourly,
// minute-level, or Monday-to-Friday schedule.
export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];

// A model that guesses a value wrong gets this back verbatim. The previous
// rejection said only "must be equal to constant", which named no legal value
// and sent Kimi through thirteen rounds of guessing, so the help has to be the
// literal argument object rather than a description of it.
export const SCHEDULED_TASK_ARGUMENT_HELP = [
  'request_scheduled_task takes exactly these arguments:',
  '',
  '{',
  '  "name": "Weekday X trends",              // required — short label',
  '  "prompt": "Report what is trending ...", // required — the work to do on each run',
  '  "frequency": "daily",                    // optional — daily | weekly | monthly | quarterly | yearly',
  '  "time": "07:00",                         // optional — local 24-hour HH:MM',
  '  "dayOfWeek": 1,                          // optional — weekly only, Monday=1 ... Sunday=7',
  '  "dayOfMonth": 15,                        // optional — monthly/quarterly/yearly only, 1-31',
  '  "monthOfYear": 8,                        // optional — quarterly/yearly only, 1-12',
  '  "destinationType": "newChat",            // optional — newChat | existingChat',
  '  "destinationChatId": "chat-abc123"       // optional — only for existingChat',
  '}',
  '',
  'Only name and prompt are required. Every other argument is optional, is repaired',
  'when it is close, and is defaulted when it is missing or unusable — so send one',
  'best-guess call and never retry this tool to search for accepted values.'
].join('\n');

// How many unusable calls the tool answers with help before it stops answering
// at all. Without a cap the model can retry until it exhausts the turn.
export const MAX_SCHEDULED_TASK_REJECTIONS = 2;

const NOTE_UNRECOGNIZED =
  'The requested repeat was not recognised, so this defaults to every day. Pick the schedule you want.';
const NOTE_WEEKDAYS =
  'Raynard cannot schedule Monday to Friday only. This runs every day instead — switch it to Weekly for a single weekday.';
const NOTE_SUB_DAILY = 'Raynard’s shortest schedule is daily, so this runs once a day at the time below.';
const NOTE_EVERY_OTHER_WEEK = 'Raynard cannot skip weeks, so this runs every week.';
const NOTE_UNKNOWN_CHAT =
  'That destination chat could not be found, so results go to a dedicated task chat. Choose another destination if you meant an existing one.';

// Ordered: the first match wins, so "weekdays" is caught before "week" and
// "every 3 months" before "month".
const FREQUENCY_PATTERNS = [
  [/week ?day|work ?day|business day|mon(day)?\s*(-|–|to|through|thru)\s*fri(day)?/, 'daily', NOTE_WEEKDAYS],
  [/minute|hourly|hour|\d+\s*h\b/, 'daily', NOTE_SUB_DAILY],
  [/fortnight|bi[- ]?weekly|every other week|every 2 weeks|every two weeks/, 'weekly', NOTE_EVERY_OTHER_WEEK],
  [/quarter|every 3 months|every three months/, 'quarterly', ''],
  [/annual|year/, 'yearly', ''],
  [/month/, 'monthly', ''],
  [/week/, 'weekly', ''],
  [/dai?ly|every day|each day|nightly|day/, 'daily', '']
];

const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
];

function pad(value) {
  return String(value).padStart(2, '0');
}

// Returns a usable frequency for every input, plus the sentence the user needs
// when the answer is an approximation rather than what they asked for.
export function normalizeScheduleFrequency(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');
  if (!text) return { frequency: 'daily', note: NOTE_UNRECOGNIZED };
  if (SCHEDULE_FREQUENCIES.includes(text)) return { frequency: text, note: '' };
  for (const [pattern, frequency, note] of FREQUENCY_PATTERNS) {
    if (pattern.test(text)) return { frequency, note };
  }
  return { frequency: 'daily', note: NOTE_UNRECOGNIZED };
}

// Accepts "07:00", "7:00", "7am", "7 PM", and falls back rather than failing.
export function normalizeScheduleTime(raw, fallback) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '');
  if (!text) return fallback;
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return fallback;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (match[3] === 'am') hour = hour === 12 ? 0 : hour;
  else if (match[3] === 'pm') hour = hour === 12 ? 12 : hour + 12;
  if (hour > 23 || minute > 59) return fallback;
  return `${pad(hour)}:${pad(minute)}`;
}

// Monday=1 through Sunday=7, also accepting cron's Sunday=0 and day names.
export function normalizeDayOfWeek(raw, fallback) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    if (value === 0) return 7;
    return value >= 1 && value <= 7 ? value : fallback;
  }
  const index = WEEKDAY_NAMES.findIndex((name) => name.startsWith(text.slice(0, 3)));
  return index >= 0 ? index + 1 : fallback;
}

export function normalizeMonthOfYear(raw, fallback) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return value >= 1 && value <= 12 ? value : fallback;
  }
  const index = MONTH_NAMES.findIndex((name) => name.startsWith(text.slice(0, 3)));
  return index >= 0 ? index + 1 : fallback;
}

export function normalizeDayOfMonth(raw, fallback) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  return value >= 1 && value <= 31 ? value : fallback;
}

export function normalizeDestinationType(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, '');
  if (!text) return 'newChat';
  if (/^(existingchat|existing|current|thischat|this|samechat|same)$/.test(text)) return 'existingChat';
  return 'newChat';
}

// A short label derived from the work itself, so a call that supplied only a
// prompt still produces a nameable task instead of being rejected.
function nameFromPrompt(prompt) {
  const sentence = prompt.split(/(?<=[.!?])\s|\n/)[0].trim();
  const source = sentence || prompt;
  if (source.length <= 60) return source;
  const clipped = source.slice(0, 60);
  const boundary = clipped.lastIndexOf(' ');
  return `${(boundary > 20 ? clipped.slice(0, boundary) : clipped).trim()}…`;
}

export function createScheduledTaskTool(Type, onRequest, options = {}) {
  const context = options.context || {};
  const now = new Date(context.localDateTime || Date.now());
  const validNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const defaultTime = `${pad(validNow.getHours())}:${pad(validNow.getMinutes())}`;
  const knownChats = new Set(
    (Array.isArray(context.chats) ? context.chats : []).map((chat) => String(chat.id || ''))
  );
  if (context.currentChatId) knownChats.add(String(context.currentChatId));
  let rejections = 0;
  // Deliberately plain strings and integers rather than Type.Union/Type.Literal.
  // TypeBox renders a union of literals as anyOf/const, which some providers do
  // not surface to the model at all: Kimi K2.5 invented five frequency values
  // that matched the real anyOf only in count. A described string reads
  // correctly everywhere, and execute below repairs whatever arrives.
  const numberOrString = (description) => Type.Union([Type.Integer(), Type.String()], { description });
  return {
    name: 'request_scheduled_task',
    label: 'Request Scheduled Task',
    description: `Prepare recurring work for the user to confirm. Nothing is created until the user confirms it in an editable form, so one best-guess call is always better than a retry.

Raynard runs a task daily, weekly, monthly, quarterly, or yearly at a single local clock time. There is no hourly, minute-level, or Monday-to-Friday schedule; pick the closest one and the user adjusts it.

Only name and prompt are required. Omit any part of the schedule you are unsure of and the user selects it. This tool never fails because of a schedule it did not understand.

${SCHEDULED_TASK_ARGUMENT_HELP}`,
    parameters: Type.Object({
      // Optional in the schema even though both are required in practice: a
      // schema-level rejection is raised by pi before execute runs, so its
      // message cannot carry SCHEDULED_TASK_ARGUMENT_HELP. Letting every call
      // reach execute is what makes the failure message teach.
      name: Type.Optional(
        Type.String({ description: 'Required. Concise task name, for example "Weekday X trends".' })
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            'Required. The work to perform on each run, with scheduling language removed.'
        })
      ),
      frequency: Type.Optional(
        Type.String({
          description:
            'One of daily, weekly, monthly, quarterly, yearly. Omit it when the request does not map cleanly and the user will choose.'
        })
      ),
      time: Type.Optional(
        Type.String({ description: 'Local 24-hour clock time as HH:MM, for example "07:00".' })
      ),
      dayOfWeek: Type.Optional(numberOrString('Weekly schedules only. Monday=1 through Sunday=7.')),
      dayOfMonth: Type.Optional(
        numberOrString('Monthly, quarterly, and yearly schedules only. Calendar day 1 through 31.')
      ),
      monthOfYear: Type.Optional(
        numberOrString('Quarterly and yearly schedules only. Anchor month 1 through 12.')
      ),
      destinationType: Type.Optional(
        Type.String({
          description: 'Either "newChat" for a dedicated task chat (the default) or "existingChat".'
        })
      ),
      destinationChatId: Type.Optional(
        Type.String({
          description: 'Exact saved chat ID. Required only when destinationType is "existingChat".'
        })
      )
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const suppliedName = String(args?.name || '').trim().slice(0, 120);
      const suppliedPrompt = String(args?.prompt || '').trim();
      // The work itself is the only thing that cannot be defaulted. Either
      // field alone is enough to build a task the user can finish editing.
      if (!suppliedName && !suppliedPrompt) {
        rejections += 1;
        if (rejections > MAX_SCHEDULED_TASK_REJECTIONS) {
          return {
            content: [
              {
                type: 'text',
                text: `Scheduling was abandoned after ${rejections} calls with no name and no prompt. Do not call request_scheduled_task again in this turn. Tell the user no task was created and ask what the recurring prompt should be.`
              }
            ],
            details: { type: 'scheduled-task-request-rejected', reason: 'retry-cap' },
            terminate: true
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `A scheduled task needs a prompt describing the work, a name, or both. Everything else is optional.\n\n${SCHEDULED_TASK_ARGUMENT_HELP}`
            }
          ],
          details: { type: 'scheduled-task-request-rejected', reason: 'missing-content' },
          terminate: false
        };
      }
      const prompt = suppliedPrompt || suppliedName;
      const name = suppliedName || nameFromPrompt(prompt).slice(0, 120);

      const { frequency, note: frequencyNote } = normalizeScheduleFrequency(args?.frequency);
      const destinationChatId = String(args?.destinationChatId || '').trim();
      let destinationType = normalizeDestinationType(args?.destinationType);
      // A chat ID the host does not know is corrected to a dedicated chat
      // rather than rejected: the destination is a dropdown in the very next
      // thing the user sees, so a wrong guess costs them one click.
      let destinationNote = '';
      if (destinationType === 'existingChat' && !knownChats.has(destinationChatId)) {
        destinationType = 'newChat';
        destinationNote = NOTE_UNKNOWN_CHAT;
      }
      const scheduleNote = [frequencyNote, destinationNote].filter(Boolean).join(' ');

      const request = {
        name,
        prompt,
        destinationType,
        destinationChatId: destinationType === 'existingChat' ? destinationChatId : undefined,
        schedule: {
          frequency,
          time: normalizeScheduleTime(args?.time, defaultTime),
          timeZone: String(context.timeZone || 'UTC'),
          dayOfWeek:
            frequency === 'weekly'
              ? normalizeDayOfWeek(args?.dayOfWeek, ((validNow.getDay() + 6) % 7) + 1)
              : undefined,
          dayOfMonth: ['monthly', 'quarterly', 'yearly'].includes(frequency)
            ? normalizeDayOfMonth(args?.dayOfMonth, validNow.getDate())
            : undefined,
          monthOfYear: ['quarterly', 'yearly'].includes(frequency)
            ? normalizeMonthOfYear(args?.monthOfYear, validNow.getMonth() + 1)
            : undefined
        },
        // Shown above the confirmation form. This is the only way the user
        // learns that their wording was approximated rather than honoured.
        scheduleNote: scheduleNote || undefined
      };
      onRequest(request);
      return {
        content: [
          {
            type: 'text',
            text: scheduleNote
              ? `The scheduled task is ready for user confirmation. The schedule was adjusted: ${scheduleNote} The user is being shown that note and can change the schedule before saving, so do not call this tool again.`
              : 'The scheduled task is ready for user confirmation.'
          }
        ],
        details: { type: 'scheduled-task-request', ...request },
        terminate: true
      };
    }
  };
}

export function buildPiTypeFromSchema(Type, schemaNode) {
  if (!schemaNode || typeof schemaNode !== 'object') {
    return Type.String();
  }

  const options = schemaNode.description ? { description: String(schemaNode.description) } : {};
  // Kept as a JSON Schema `enum`. Type.Union([Type.Literal(...)]) renders as
  // anyOf/const, which some providers never surface to the model — it then
  // guesses values and every call fails validation. Ajv enforces `enum` just as
  // strictly, so this only changes what the model can read.
  if (Array.isArray(schemaNode.enum) && schemaNode.enum.length) {
    const kinds = new Set(schemaNode.enum.map((value) => typeof value));
    const kind = kinds.size === 1 ? [...kinds][0] : '';
    return Type.Unsafe({
      ...(kind === 'string' || kind === 'number' || kind === 'boolean'
        ? { type: kind === 'number' ? 'number' : kind }
        : {}),
      enum: [...schemaNode.enum],
      ...options
    });
  }
  if (Array.isArray(schemaNode.anyOf) && schemaNode.anyOf.length) {
    return Type.Union(
      schemaNode.anyOf.map((entry) => buildPiTypeFromSchema(Type, entry)),
      options
    );
  }

  switch (schemaNode.type) {
    case 'boolean':
      return Type.Boolean(options);
    case 'integer':
      return Type.Integer(options);
    case 'number':
      return Type.Number(options);
    case 'array':
      return Type.Array(buildPiTypeFromSchema(Type, schemaNode.items || {}), options);
    case 'object': {
      const properties =
        schemaNode.properties && typeof schemaNode.properties === 'object'
          ? schemaNode.properties
          : {};
      const required = new Set(Array.isArray(schemaNode.required) ? schemaNode.required : []);
      const shape = {};
      for (const [name, property] of Object.entries(properties)) {
        const propertyType = buildPiTypeFromSchema(Type, property);
        shape[name] = required.has(name) ? propertyType : Type.Optional(propertyType);
      }
      return Type.Object(shape, options);
    }
    case 'string':
    default:
      return Type.String(options);
  }
}

/**
 * Failures where another attempt is the right answer.
 *
 * These are the provider's own capacity and availability errors, not anything
 * about the request: an observed turn made 13 successful tool calls and then
 * died on `429 The engine is currently overloaded`, discarding all of it. The
 * classifier is deliberately narrow — retrying a bad key or an exhausted
 * context just spends the user's time to reach the same failure.
 */
const TRANSIENT_REASONS = [
  // Rate limiting is checked before generic overload so a 429 that names a
  // quota does not get reported as server capacity.
  ['rate_limited', /\brate[\s_-]?limit|too many requests|quota exceeded/i],
  ['overloaded', /overloaded|capacity|\bbusy\b|congest/i],
  ['unavailable', /\b(5\d\d)\b|unavailable|bad gateway|server error/i],
  ['timeout', /timed?[\s_-]?out|timeout|etimedout|econnreset|socket hang up/i]
];

/** Failures no retry can fix, checked first so they always win. */
const PERMANENT_ERROR = /\b(400|401|403|404)\b|invalid[\s_-]?api[\s_-]?key|incorrect api key|invalid authentication|unauthorized|forbidden|context[\s_-]?length|maximum context|too long/i;

/** Longest server-requested wait we will honour before giving up instead. */
const MAX_SERVER_RETRY_DELAY_MS = 60_000;

/**
 * The reason slug behind a transient failure, or null when it is not transient.
 *
 * A plain `429` with no other signal is capacity — that is what providers mean
 * by it when no quota is named.
 */
export function transientReason(message) {
  const text = String(message ?? '').trim();
  if (!text) return null;
  if (PERMANENT_ERROR.test(text)) return null;
  for (const [reason, pattern] of TRANSIENT_REASONS) {
    if (pattern.test(text)) return reason;
  }
  return /\b429\b/.test(text) ? 'overloaded' : null;
}

export function isTransientModelError(message) {
  return transientReason(message) !== null;
}

/**
 * A wait the provider explicitly asked for, in milliseconds.
 *
 * Returns null when the message names none, or names one longer than we are
 * willing to hold the turn open for — the caller then falls back to its own
 * backoff or gives up.
 */
export function retryAfterMs(message) {
  const text = String(message ?? '');
  const match =
    /retry[\s_-]?after["':\s]*([\d.]+)\s*(ms|s|seconds?)?/i.exec(text) ||
    /try again in\s*([\d.]+)\s*(ms|s|seconds?)/i.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = /^ms$/i.test(match[2] || '') ? value : value * 1000;
  return ms > MAX_SERVER_RETRY_DELAY_MS ? null : Math.round(ms);
}

/** How many times a transient provider failure is resumed before giving up. */
export const MAX_TRANSIENT_RESUMES = 3;
const RESUME_BACKOFF_MS = [2_000, 6_000, 15_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drop the empty assistant message a failed round leaves behind.
 *
 * Pi records a provider failure as an assistant message carrying
 * `stopReason: 'error'` and no text. Removing exactly that message puts the last
 * successful tool result back at the tail, which is what `agent.continue()`
 * requires — so the resumed round re-runs the failed step with every earlier
 * tool call intact instead of restarting the turn.
 *
 * Returns false when the transcript does not look like that, in which case the
 * caller must surface the error rather than guess.
 */
function dropFailedRound(agent) {
  const messages = agent?.state?.messages;
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.stopReason !== 'error') return false;
  const previous = messages.at(-2);
  if (previous?.role !== 'user' && previous?.role !== 'toolResult') return false;
  messages.pop();
  return true;
}

/**
 * Run a turn, resuming it when the provider fails for a reason a retry can fix.
 *
 * `start` runs the turn once. After it settles, `readFailure` reports how the
 * last round ended; a transient failure is waited out and handed back to
 * `agent.continue()`. Non-transient failures and a used-up attempt budget fall
 * through to the caller untouched.
 */
export async function runWithTransientResume({
  agent,
  start,
  readFailure,
  onResume,
  resetRound,
  maxAttempts = MAX_TRANSIENT_RESUMES,
  wait = sleep
}) {
  await start();

  let attempts = 0;
  while (attempts < maxAttempts) {
    const { stopReason, errorMessage } = readFailure() || {};
    if (stopReason !== 'error') break;
    const reason = transientReason(errorMessage);
    if (!reason) break;
    if (!dropFailedRound(agent)) break;

    const delayMs = retryAfterMs(errorMessage) ?? RESUME_BACKOFF_MS[attempts] ?? RESUME_BACKOFF_MS.at(-1);
    attempts += 1;
    onResume?.({ reason, attempt: attempts, maxAttempts, delayMs, error: String(errorMessage || '') });
    await wait(delayMs);
    resetRound?.();
    await agent.continue();
  }

  return { resumeAttempts: attempts };
}

/** Ceilings for the model-facing view of one tool result. */
export const MODEL_RESULT_BYTE_LIMIT = 12000;
const MODEL_RESULT_TEXT_LIMIT = 8000;
const MODEL_RESULT_MAX_CITATIONS = 20;

/**
 * Build the model's view of a tool result.
 *
 * A result carries three audiences in one object: `text` for the model, `data` +
 * `card` for the host's result card, and `references[].expandedContent` for the
 * citation modal. The host already receives all of it through the tool's
 * `details`, so serializing the whole thing here put the same rows in the model's
 * context three times — one observed turn spent ~206k tokens on payload of which
 * ~98% was unreadable to the model, and the turn died on the final round.
 *
 * So: `text` verbatim (the summary the model reasons and charts from), compact
 * citations, and `data` only if it fits what is left of the budget. Anything
 * dropped is announced, never silently, so the model narrows its query instead
 * of charting a partial slice.
 */
/**
 * Numbers a tool result's references within the turn.
 *
 * The model cites a reference by number, so the number has to mean the same
 * thing from the first tool call to the last — numbering per result would make
 * `[^1]` a different source three calls later. The number is stamped onto the
 * reference itself because the host receives these same objects through the
 * tool's `details`, and both sides have to agree on what `[^3]` points at.
 */
export function assignCitationNumbers(result, counter) {
  if (!result || typeof result !== 'object' || !counter) return;
  const references = Array.isArray(result.references) ? result.references : [];
  for (const reference of references) {
    if (!reference || typeof reference !== 'object') continue;
    reference.citationNumber = counter.next;
    counter.next += 1;
  }
}

/** A turn-scoped citation counter, shared by every plugin tool in one run. */
export function createCitationCounter() {
  return { next: 1 };
}

export function formatToolResult(result) {
  if (!result || typeof result !== 'object') return String(result ?? '');

  const sections = [];
  const notices = [];

  const rawText = typeof result.text === 'string' ? result.text : '';
  if (rawText.length > MODEL_RESULT_TEXT_LIMIT) {
    sections.push(rawText.slice(0, MODEL_RESULT_TEXT_LIMIT));
    notices.push(
      `[host] Summary truncated at ${MODEL_RESULT_TEXT_LIMIT} of ${rawText.length} characters. Narrow the query and call again rather than treating this as the complete result.`
    );
  } else if (rawText) {
    sections.push(rawText);
  }

  const references = Array.isArray(result.references) ? result.references : [];
  const citations = references
    .slice(0, MODEL_RESULT_MAX_CITATIONS)
    .map((reference, index) => {
      const number = Number(reference?.citationNumber) || index + 1;
      const label = String(reference?.referenceLabel || `Reference ${number}`).trim();
      const url = String(reference?.referenceMeta?.sourceUrl || '').trim();
      return url ? `[^${number}] ${label} — ${url}` : `[^${number}] ${label}`;
    });
  if (citations.length) {
    sections.push(`Sources:\n${citations.join('\n')}`);
    if (references.length > citations.length) {
      notices.push(`[host] ${references.length - citations.length} further source(s) omitted.`);
    }
  }

  // `data` is the card's payload; include it only when it is genuinely small
  // enough to be a bonus on top of the summary.
  if (result.data !== undefined && result.data !== null) {
    let serialized = '';
    try {
      serialized = JSON.stringify(result.data);
    } catch {
      serialized = '';
    }
    const used = sections.join('\n\n').length;
    const remaining = MODEL_RESULT_BYTE_LIMIT - used;
    if (serialized && serialized.length <= remaining) {
      sections.push(`Structured data:\n${serialized}`);
    } else if (serialized) {
      notices.push(
        `[host] Structured data omitted (${serialized.length} characters). The summary above is authoritative. Narrow the query with this tool's filter parameters and call it again if you need rows the summary does not show.`
      );
    }
  }

  if (notices.length) sections.push(notices.join('\n'));
  const formatted = sections.filter(Boolean).join('\n\n');
  return formatted || JSON.stringify(result.data ?? result) || '';
}

function normalizeMissingCredentials(plugin, only) {
  const declared = Array.isArray(plugin.missingCredentials) ? plugin.missingCredentials : [];
  const wanted = declared
    .map((entry) => ({
      key: String(entry?.key || '').trim(),
      label: String(entry?.label || entry?.key || '').trim(),
      description: String(entry?.description || '').trim(),
      signupUrl: String(entry?.signupUrl || '').trim()
    }))
    .filter((entry) => entry.key);
  if (!only) return wanted;
  // A runtime miss names one credential; report only that one so the prompt
  // matches what actually blocked the call.
  const matched = wanted.find((entry) => entry.key === only.key);
  return [matched || { key: only.key, label: only.label || only.key, description: '', signupUrl: '' }];
}

function buildCredentialRequest(plugin, only) {
  return {
    pluginId: String(plugin.id || ''),
    pluginName: String(plugin.name || plugin.id || 'This plugin'),
    credentials: normalizeMissingCredentials(plugin, only)
  };
}

/**
 * Ends the turn with a structured request for the user rather than letting the
 * model retry a tool it can never satisfy or answer from memory instead.
 */
function credentialRequestResult(credentialRequest) {
  const names = credentialRequest.credentials.map((entry) => entry.label).join(', ');
  return {
    content: [
      {
        type: 'text',
        text: `${credentialRequest.pluginName} needs ${names} before this tool can run. The user has been asked for it. Do not answer from general knowledge and do not retry the tool.`
      }
    ],
    details: { type: 'credential-request', ...credentialRequest },
    terminate: true
  };
}

export function createGeneratedPluginTools({
  Type,
  plugins,
  executePluginTool,
  onCredentialRequest = () => {}
}) {
  const seen = new Set();
  const tools = [];
  // One counter for the whole turn, so citation numbers stay unique across
  // every tool call the model makes.
  const citationCounter = createCitationCounter();
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    for (const definition of Array.isArray(plugin.tools) ? plugin.tools : []) {
      const name = String(definition.name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      // Fixed card layout authored by the builder and carried through discovery.
      // Merged into the tool result below so the frontend receives template +
      // data in one event and needs no separate tool-catalog lookup.
      const card = definition.card;
      if (!card || typeof card !== 'object') {
        throw new Error(`Generated plugin tool ${name} is missing its required result card.`);
      }
      tools.push({
        name,
        label: name,
        description: String(definition.description || '').trim(),
        parameters: buildPiTypeFromSchema(
          Type,
          definition.parameters || { type: 'object', properties: {} }
        ),
        execute: async (_toolCallId, args, signal) => {
          // Pre-flight: the host already knows which declared credentials are
          // unset, so a doomed call never spawns a process or hits the network.
          const missing = normalizeMissingCredentials(plugin);
          if (missing.length) {
            const credentialRequest = buildCredentialRequest(plugin);
            onCredentialRequest(credentialRequest);
            return credentialRequestResult(credentialRequest);
          }

          let result;
          try {
            result = await executePluginTool(
              {
                pluginDir: String(plugin.directory || ''),
                pluginId: String(plugin.id || ''),
                toolName: name,
                args: args && typeof args === 'object' ? args : {},
                credentials:
                  plugin.credentialValues && typeof plugin.credentialValues === 'object'
                    ? plugin.credentialValues
                    : {}
              },
              signal
            );
          } catch (error) {
            // Backstop for a credential the manifest never declared, which
            // pre-flight cannot see.
            if (!error || !error.credentialRequest) throw error;
            const credentialRequest = buildCredentialRequest(plugin, error.credentialRequest);
            onCredentialRequest(credentialRequest);
            return credentialRequestResult(credentialRequest);
          }
          // Number before formatting: the model's citation list and the host's
          // stored citations are then the same numbers on the same references.
          assignCitationNumbers(result, citationCounter);
          const details =
            result && typeof result === 'object' ? { ...result, card } : result;
          return {
            content: [{ type: 'text', text: formatToolResult(result) }],
            details
          };
        }
      });
    }
  }
  return tools;
}

function normalizePluginName(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'generated-capability';
}

function normalizeSourceUrls(values) {
  const urls = [];
  for (const value of Array.isArray(values) ? values : []) {
    try {
      const url = new URL(String(value));
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !urls.includes(url.href)) {
        urls.push(url.href);
      }
    } catch {}
  }
  return urls;
}

function presentChartText(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function presentChartNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.trim().replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalize the native chart tool's arguments to the renderer's ChartSpec contract. */
export function normalizePresentedChart(args) {
  const record = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const type = presentChartText(record.type);
  if (type !== 'line' && type !== 'bar') throw new Error('Chart type must be line or bar.');

  const x = presentChartText(record.x);
  if (!x) throw new Error('Chart x is required.');

  if (!Array.isArray(record.series) || !record.series.length) {
    throw new Error('Chart series is required, including for a single-series chart.');
  }
  const seenSeries = new Set();
  const series = record.series.slice(0, 8).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Every chart series must be an object with a key.');
    }
    const key = presentChartText(entry.key);
    if (!key || seenSeries.has(key)) throw new Error('Every chart series needs a unique key.');
    const axis = presentChartText(entry.axis);
    if (axis && axis !== 'left' && axis !== 'right') {
      throw new Error(`Chart series "${key}" has an invalid axis.`);
    }
    seenSeries.add(key);
    return {
      key,
      label: presentChartText(entry.label) || key,
      ...(axis === 'right' ? { axis } : {})
    };
  });

  const hasRightAxis = series.some((entry) => entry.axis === 'right');
  const hasLeftAxis = series.some((entry) => entry.axis !== 'right');
  if (hasRightAxis && !hasLeftAxis) {
    throw new Error('A right-axis series requires at least one left-axis series.');
  }
  if (type === 'bar' && record.stacked === true && hasRightAxis) {
    throw new Error('A stacked bar chart cannot use a right axis.');
  }

  if (!Array.isArray(record.rows) || !record.rows.length) throw new Error('Chart rows are required.');
  let plottable = 0;
  const rows = record.rows.slice(0, 200).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Every chart row must be an object.');
    }
    const rawX = entry[x];
    const row = { [x]: typeof rawX === 'number' ? rawX : presentChartText(rawX) || '' };
    for (const item of series) {
      if (item.key === x) continue;
      const numeric = presentChartNumber(entry[item.key]);
      row[item.key] = numeric;
      if (numeric !== null) plottable += 1;
    }
    return row;
  });
  if (!plottable) throw new Error('No chart series key resolves to a numeric row value.');

  const highlight = Array.isArray(record.highlight)
    ? [...new Set(record.highlight.map(presentChartText).filter(Boolean))].slice(0, 8)
    : [];
  const sources = Array.isArray(record.sources)
    ? [...new Set(record.sources.map(Number).filter((value) => Number.isInteger(value) && value > 0))].slice(0, 8)
    : [];

  return {
    type,
    ...(presentChartText(record.title) ? { title: presentChartText(record.title) } : {}),
    x,
    ...(presentChartText(record.xLabel) ? { xLabel: presentChartText(record.xLabel) } : {}),
    ...(presentChartText(record.yLabel) ? { yLabel: presentChartText(record.yLabel) } : {}),
    ...(hasRightAxis && presentChartText(record.rightYLabel)
      ? { rightYLabel: presentChartText(record.rightYLabel) }
      : {}),
    ...(type === 'bar' && record.stacked === true ? { stacked: true } : {}),
    ...(highlight.length ? { highlight } : {}),
    ...(sources.length ? { sources } : {}),
    series,
    rows
  };
}

/**
 * Present a validated chart as structured host data rather than model-authored
 * JSON inside Markdown. Invalid arguments become an ordinary tool error, giving
 * the agent another round in which to correct them.
 */
export function createPresentChartTool(Type, onPresentChart = () => {}) {
  const cell = Type.Union([Type.String(), Type.Number(), Type.Null()]);
  return {
    name: 'present_chart',
    label: 'Present Chart',
    description:
      'Attach one validated line or bar chart to this answer after retrieving the plotted values from API tools in the current turn. Call once per chart. Always declare series explicitly, even when there is only one. After this succeeds, write concise interpretation only: never repeat the chart as JSON, a chart fence, or a Markdown table.',
    parameters: Type.Object({
      type: Type.Union([Type.Literal('line'), Type.Literal('bar')]),
      title: Type.Optional(Type.String()),
      x: Type.String({ description: 'Row key used for the horizontal axis.' }),
      xLabel: Type.Optional(Type.String()),
      yLabel: Type.Optional(Type.String()),
      rightYLabel: Type.Optional(Type.String()),
      stacked: Type.Optional(Type.Boolean({ description: 'Bar charts only.' })),
      highlight: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
      sources: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1 }), {
          maxItems: 8,
          description: 'Citation numbers for the API calls that supplied the plotted rows.'
        })
      ),
      series: Type.Array(
        Type.Object({
          key: Type.String({ description: 'Numeric key present on the row objects.' }),
          label: Type.Optional(Type.String()),
          axis: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right')]))
        }),
        { minItems: 1, maxItems: 8 }
      ),
      rows: Type.Array(Type.Record(Type.String(), cell), { minItems: 1, maxItems: 200 })
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const chart = normalizePresentedChart(args);
      onPresentChart(chart);
      return {
        content: [
          {
            type: 'text',
            text: 'The chart is attached to the answer. Continue with concise interpretation only; do not reproduce its rows or JSON.'
          }
        ],
        details: { type: 'presented-chart', chart }
      };
    }
  };
}

export function createDirectAnswerTool(Type, onDirectAnswer) {
  return {
    name: 'answer_without_api',
    label: 'Answer Without API',
    description:
      'Finish a turn without API evidence for greetings, casual conversation, stable explanations, or a concise clarification about the intended data/API source. When no credible API is established, use this to ask where the information should come from, suggest concrete public APIs you genuinely know are available, or ask whether the user meant one of the relevant installed plugins. Never use this to make external, private, current, or API-backed factual claims, comparisons, or records.',
    parameters: Type.Object({
      answer: Type.String({
        description: 'The complete concise answer to show to the user.'
      }),
      reason: Type.String({
        description: 'Why this answer does not require current-turn API evidence.'
      })
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const answer = String(args?.answer || '').trim() || 'How can I help?';
      onDirectAnswer(answer);
      return {
        content: [{ type: 'text', text: answer }],
        details: { type: 'direct-answer', answer },
        terminate: true
      };
    }
  };
}

function normalizedAvailableExtensions(extensions) {
  return (Array.isArray(extensions) ? extensions : [])
    .filter((extension) => extension && extension.installed !== true)
    .map((extension) => ({
      slug: String(extension.slug || '').trim(),
      name: String(extension.name || extension.slug || '').trim(),
      description: String(extension.description || '').trim(),
      category: String(extension.category || '').trim(),
      tools: (Array.isArray(extension.tools) ? extension.tools : []).map((tool) => ({
        name: String(tool?.name || '').trim(),
        description: String(tool?.description || '').trim()
      }))
    }))
    .filter((extension) => extension.slug && extension.name);
}

export function createAvailableExtensionSearchTool(Type, extensions) {
  const available = normalizedAvailableExtensions(extensions);

  return {
    name: 'search_available_extensions',
    label: 'Search Available Extensions',
    description:
      'Inspect the on-demand catalog of extensions that are available but not installed. Call this before answering any factual or data question that no installed API tool can answer. Do not call it for greetings, stable explanations, or explicit edits to an existing plugin.',
    parameters: Type.Object({
      query: Type.String({
        description: 'A concise description of the missing data or capability the user needs.'
      })
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const query = String(args?.query || '').trim().toLowerCase();
      const tokens = [...new Set(query.match(/[a-z0-9]+/g) || [])].filter(
        (token) => token.length > 2
      );
      const ranked = available
        .map((extension, index) => {
          const haystack = [
            extension.name,
            extension.description,
            extension.category,
            ...extension.tools.flatMap((tool) => [tool.name, tool.description])
          ]
            .join(' ')
            .toLowerCase();
          return {
            extension,
            index,
            score: tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0)
          };
        })
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, 12)
        .map(({ extension }) => extension);
      const catalogText = ranked.length
        ? ranked
            .map((extension) => {
              const tools = extension.tools
                .map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`)
                .join('; ');
              return `- ${extension.name} (${extension.slug})${extension.category ? ` [${extension.category}]` : ''}: ${extension.description}${tools ? ` Tools: ${tools}` : ''}`;
            })
            .join('\n')
        : '(No extensions are currently available to install.)';
      const text = `Available extensions, ordered by textual relevance to "${query || 'the requested capability'}":\n${catalogText}\n\nWhen one declared capability clearly fits, call recommend_available_extension with its exact slug so the host can render an Install button. Otherwise call answer_without_api. End the user-facing fallback with exactly: "Or provide me with an API documentation site and I can build one."`;
      return {
        content: [{ type: 'text', text }],
        details: { type: 'available-extension-search', query, extensions: ranked }
      };
    }
  };
}

export function createExtensionRecommendationTool(Type, extensions, onRecommendation) {
  const available = normalizedAvailableExtensions(extensions);
  const closingOffer = 'Or provide me with an API documentation site and I can build one.';
  return {
    name: 'recommend_available_extension',
    label: 'Recommend Available Extension',
    description:
      'Finish a missing-capability turn by recommending one clearly relevant extension returned by search_available_extensions. The host renders an Install button for the validated catalog slug.',
    parameters: Type.Object({
      slug: Type.String({
        description: 'Exact slug returned by search_available_extensions.'
      }),
      answer: Type.String({
        description: 'Concise user-facing explanation of why this extension fits.'
      })
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const slug = String(args?.slug || '').trim();
      const extension = available.find((candidate) => candidate.slug === slug);
      if (!extension) {
        return {
          content: [
            {
              type: 'text',
              text: 'That slug is not an available catalog extension. Search the catalog again or use answer_without_api.'
            }
          ],
          details: { type: 'extension-recommendation-rejected', slug },
          terminate: false
        };
      }
      const supplied = String(args?.answer || '').trim();
      const answer = supplied.includes(closingOffer)
        ? supplied
        : `${supplied || `${extension.name} is available to install.`}\n\n${closingOffer}`;
      const recommendation = {
        slug: extension.slug,
        name: extension.name,
        description: extension.description,
        answer
      };
      onRecommendation(recommendation);
      return {
        content: [{ type: 'text', text: answer }],
        details: { type: 'extension-recommendation', ...recommendation },
        terminate: true
      };
    }
  };
}

/**
 * Advance notice that the plugin about to be built will need a key. It lets the
 * confirmation card send the user off to register while the build runs, instead
 * of surprising them with the requirement once it finishes.
 */
function normalizeBuildRequestAuth(auth) {
  if (!auth || typeof auth !== 'object' || auth.required !== true) return undefined;
  const signupUrl = String(auth.signupUrl || '').trim();
  return {
    required: true,
    signupUrl: /^https?:\/\//i.test(signupUrl) ? signupUrl : '',
    credentialLabel: String(auth.credentialLabel || '').trim().slice(0, 120)
  };
}

export function createBuildRequestTool(Type, onBuildRequest, options = {}) {
  const installedPluginNames = new Set(
    (Array.isArray(options.installedPluginNames) ? options.installedPluginNames : [])
      .map((value) => normalizePluginName(value))
      .filter(Boolean)
  );
  return {
    name: 'request_plugin_build',
    label: 'Request Plugin Build',
    description:
      'Request user confirmation to create or extend an API-backed Raynard plugin, or to change how an existing plugin presents its results — for example, adding result cards to specific tools. A new plugin requires at least one real official API documentation URL; never use this tool for a speculative capability with no established data source. Existing installed-plugin edits may omit source URLs. This tool never writes code itself.',
    parameters: Type.Object({
      name: Type.String({
        description:
          'Plugin to build or edit. To EDIT an existing plugin, pass its exact installed name/slug (e.g. "dnd-5e-api") so it is edited in place; a non-matching name creates a new empty plugin. Use a fresh short slug (e.g. hacker-news, sec-filings) only when creating a genuinely new plugin.'
      }),
      description: Type.String({
        description:
          'Complete capability the coding agent should implement, including the broader useful API surface rather than only one example query.'
      }),
      sourceUrls: Type.Optional(
        Type.Array(
          Type.String({
            description: 'Official API documentation URL.'
          }),
          {
            description:
              'Relevant real API documentation URLs supplied by the user or reliably known. At least one is required for a new plugin.'
          }
        )
      ),
      reason: Type.String({
        description: 'Why installed tools are insufficient and code needs to be written.'
      }),
      auth: Type.Optional(
        Type.Object(
          {
            required: Type.Boolean({
              description: 'True when this API requires an API key, token, or app id to call.'
            }),
            signupUrl: Type.Optional(
              Type.String({
                description:
                  'The page where the user signs up for the key, not the generic API docs root.'
              })
            ),
            credentialLabel: Type.Optional(
              Type.String({
                description: 'Human name for the key, such as "OpenWeather API key".'
              })
            )
          },
          {
            description:
              'Whether this API needs credentials. Set it whenever the documentation says a key is required, so the user can register while the plugin is being written.'
          }
        )
      ),
      taskKind: Type.Optional(
        Type.Union(
          [
            Type.Literal('card-edit'),
            Type.Literal('plugin-edit'),
            Type.Literal('plugin-create')
          ],
          {
            description:
              'Structured AI routing metadata: card-edit for result-card changes, plugin-edit for other installed-plugin changes, or plugin-create for a new plugin.'
          }
        )
      ),
      targetTools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Exact installed tool names affected by a targeted edit, such as ["dnd_get_monster"]. Empty for broad or new-plugin work.'
        })
      )
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const buildRequest = {
        name: normalizePluginName(args?.name),
        description: String(args?.description || '').trim(),
        sourceUrls: normalizeSourceUrls(args?.sourceUrls),
        reason: String(args?.reason || '').trim(),
        auth: normalizeBuildRequestAuth(args?.auth),
        taskKind: ['card-edit', 'plugin-edit', 'plugin-create'].includes(args?.taskKind)
          ? args.taskKind
          : undefined,
        targetTools: [...new Set(
          (Array.isArray(args?.targetTools) ? args.targetTools : [])
            .map((value) => String(value).trim())
            .filter(Boolean)
        )].slice(0, 20)
      };
      const editsInstalledPlugin =
        ['card-edit', 'plugin-edit'].includes(buildRequest.taskKind) &&
        installedPluginNames.has(buildRequest.name);
      if (!buildRequest.sourceUrls.length && !editsInstalledPlugin) {
        return {
          content: [
            {
              type: 'text',
              text:
                'No credible API source was supplied, so do not offer a plugin build. Inspect the installed tools again. For a factual question with no relevant installed tool, call search_available_extensions before answer_without_api. Recommend a clearly relevant available extension when one exists; otherwise ask the user to provide or confirm the source. Then offer: "Or provide me with an API documentation site and I can build one."'
            }
          ],
          details: {
            type: 'plugin-build-request-rejected',
            reason: 'missing-api-source'
          },
          terminate: false
        };
      }
      onBuildRequest(buildRequest);
      return {
        content: [
          {
            type: 'text',
            text:
              'A structured plugin build request is ready for user confirmation. Do not provide code in chat.'
          }
        ],
        details: {
          type: 'plugin-build-request',
          ...buildRequest
        },
        terminate: true
      };
    }
  };
}

export function extractAssistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    // A provider may put prose, tool calls, and a fenced chart in separate
    // content blocks. Those blocks are semantic boundaries, not token chunks:
    // joining them directly can glue ```chart to the preceding sentence and
    // turn a valid chart into invalid Markdown.
    .join('\n\n')
    .trim();
}
