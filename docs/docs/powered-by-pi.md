---
sidebar_position: 5
---

# Powered by Pi

<div className="pi-page-intro">
  <p className="pi-page-intro__eyebrow">The agent engine inside Raynard</p>
  <p className="pi-page-intro__lead">
    Raynard uses Pi to turn a language model into an agent: something that can
    choose an action, use a tool, inspect the result, and decide what to do next.
  </p>
  <p>
    Two separate Pi agents do two different jobs. The Explore agent researches
    and answers questions. The coding agent develops extensions—called
    <strong> generated plugins</strong> in Raynard—only after you approve the work.
  </p>
</div>

## Two Pi runtimes with different tools

Explore and Build are not two labels applied to the same all-powerful agent.
Raynard starts a separate Pi runtime for each job and gives each runtime only
the tools it needs.

Both runtimes use `@mariozechner/pi-agent-core` for the `Agent` that manages
conversation state and tool execution. They also use `@mariozechner/pi-ai` to
stream requests to the model selected in Raynard. The important difference is
where their tools come from.

The Explore runtime creates a general Pi agent and supplies Raynard's own narrow
set of API tools:

```js title="Explore mode, simplified"
import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple, Type } from '@mariozechner/pi-ai';

const tools = [
  ...installedPluginTools,
  requestPluginBuild,
  answerWithoutApi,
];

const agent = new Agent({
  initialState: { model, tools, messages },
  streamFn: streamSimple,
});
```

Build mode imports an additional Pi package,
`@mariozechner/pi-coding-agent`. Its `createCodingTools()` function provides
the filesystem and shell tools needed for extension development:

```js title="Build mode, simplified"
import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import { createCodingTools } from '@mariozechner/pi-coding-agent';

const agent = new Agent({
  initialState: {
    model,
    tools: createCodingTools(pluginDirectory),
  },
  streamFn: streamSimple,
});
```

That import boundary is the practical difference between the modes. Explore
has generated API tools and a tool for proposing a build, but no file-editing
tools. Build receives Pi's coding tools, rooted in the approved plugin
directory, but it is a new agent run with a different prompt and role. The same
provider and model selected in Raynard power both runtimes.

## The Explore loop

Explore mode is the everyday Raynard experience. Every ordinary message starts
here and uses your selected model in the **Chat/Explore role**.

<div className="pi-agent-grid">
  <div className="pi-agent-card pi-agent-card--explore">
    <span className="pi-agent-card__label">Explore agent</span>
    <h3>Research and answer</h3>
    <p>Can use installed API tools, but cannot edit extension files.</p>
  </div>
  <div className="pi-agent-card pi-agent-card--build">
    <span className="pi-agent-card__label">Coding agent</span>
    <h3>Develop extensions</h3>
    <p>Can edit one plugin workspace, but starts only after confirmation.</p>
  </div>
</div>

At the start of a turn, Raynard discovers the tools supplied by your installed
plugins. Each plugin's JSON parameter schema is converted into the typed tool
shape expected by Pi, and its execution function is wrapped so Raynard can run
it through the isolated plugin runner. The Explore agent therefore sees ordinary
native tools with a name, description, parameters, and a result.

During the agent run:

1. The agent decides whether the request needs current or API-backed data.
2. If an installed plugin can help, the agent calls the most appropriate tool.
3. Raynard runs that tool in isolation and returns its text, structured data,
   result card, and source references to the agent.
4. The agent can call another tool if it needs more evidence or a follow-up
   record.
5. Once it has enough information, it writes a readable answer with citations.

`pi-agent-core` adds each tool result back to the agent conversation and asks the
model what to do next. This is not a fixed chain: one question may need a single
lookup, while another may require a search, several detail calls, and a
comparison before the model produces its final answer. Tool calls run
sequentially so each decision can use the result that came before it.

If no installed tool provides the required access, the Explore agent does not
pretend that it has the data. Instead, it prepares a plugin proposal describing
the capability, documentation sources, and reason for the build. You remain in
Explore mode while you review that proposal.

## The handoff to extension development

The two agents are separated by an explicit confirmation step:

<div className="pi-handoff">
  <div><strong>Explore</strong><span>Identifies a missing or changed capability</span></div>
  <div className="pi-handoff__gate"><span>Requires your confirmation</span></div>
  <div><strong>Build</strong><span>Starts a scoped coding-agent pass</span></div>
</div>

The Explore agent never writes plugin code. Confirming the proposal is what
authorizes Raynard to scaffold a new plugin, or open an existing one for an
in-place edit, and start the separate coding agent.

## The extension-development loop

In Build mode, Pi uses the same selected model in the **Coding/Build role**. The
tools returned by `createCodingTools(pluginDirectory)` let the agent read,
search, edit, and write files and run shell commands. Passing the plugin
directory is important: it roots those tools in the one extension workspace
selected for the build.

Raynard streams Pi's filesystem and test events into the activity timeline, so
you can see which files are being inspected or changed and when tests run.

For a new extension, the loop is:

1. Read the requested capability and API documentation.
2. Write mocked tests that describe the expected API and tool behavior.
3. Implement focused TypeScript API tools and their declarative result cards.
4. Run the tests and inspect failures.
5. Edit the code and repeat until the tests pass.
6. Document the implemented tools, source API, and endpoint inventory.
7. Load the plugin through Raynard's runtime and run final validation.

A fresh build must expose at least one working tool, pass its mocked tests, load
successfully, document its endpoint coverage, and provide three useful example
prompts. If final validation fails, the coding agent gets one focused repair
pass and validation runs again.

Editing an existing extension is deliberately lighter. Raynard gives the coding
agent the current source, asks it to make the smallest requested change, and
runs the relevant tests. It preserves the rest of the plugin instead of
rebuilding it from scratch.

## Why Raynard uses two agents

The separation keeps each loop focused and makes the transition visible:

- **Explore has data tools, not coding tools.** It can research freely without
  changing plugin files.
- **Build has scoped coding tools.** It can change only the plugin you approved,
  not the Raynard application or another extension.
- **The agent runs are independent.** Explore and Build have separate prompts
  and tools, while the provider and model you select power both.
- **Each confirmation covers one coding pass.** The next ordinary message
  returns to Explore, and another change requires another proposal and approval.

From the user's point of view, the flow is simple: ask a question, let Explore
use the tools it has, and approve a Build pass only when Raynard needs to create
or improve an extension.

Next, see [how to create a generated plugin](./plugins.md) or learn more about
[Explore and Build model roles](./chat-and-models.md).
