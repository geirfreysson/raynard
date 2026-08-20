import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Steering, driven through the real sidecar process.
 *
 * Everything this covers lives at a seam a unit test cannot reach: the stdin
 * line protocol that stays open for the life of the turn, pi's own steering
 * queue, and the `steering_applied` event the host needs to split its answer.
 * The provider is a local HTTP stub rather than a mock of pi, because the thing
 * being pinned is exactly where pi injects a queued message — after the tool
 * results of a round, before the next model request.
 */

const SIDECAR = fileURLToPath(new URL('./main-agent-sidecar.mjs', import.meta.url));
const MODEL = 'test-model';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sse(chunks) {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

function chunk(choice, usage) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, ...choice }],
    ...(usage ? { usage } : {})
  };
}

const FINAL_USAGE = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };

/** A round that answers in text and ends the turn. */
function textRound(text) {
  return [
    chunk({ delta: { role: 'assistant', content: text }, finish_reason: null }),
    chunk({ delta: {}, finish_reason: 'stop' }, FINAL_USAGE)
  ];
}

/** A round that calls one of the agent's own tools, forcing a second request. */
function toolRound(name, args) {
  return [
    chunk({
      delta: {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
          }
        ]
      },
      finish_reason: null
    }),
    chunk({ delta: {}, finish_reason: 'tool_calls' }, FINAL_USAGE)
  ];
}

function startProvider(handler) {
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (part) => {
      raw += part;
    });
    request.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }
      const chunks = await handler(body);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      response.end(sse(chunks));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/**
 * Runs one turn. `plan[n]` produces the provider's nth response and receives a
 * `send` helper for writing a command down the sidecar's stdin mid-turn.
 */
async function runTurn(plan, question = 'what are the top stories?') {
  const requests = [];
  let child;
  const { server, port } = await startProvider(async (body) => {
    requests.push(body);
    const step = plan[requests.length - 1] || (() => textRound('done'));
    return step(body, {
      send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`)
    });
  });

  child = spawn(process.execPath, [SIDECAR], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const events = [];
  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // The sidecar only writes JSON lines; anything else is not our business.
    }
  });
  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (part) => {
    stderrText += part;
  });

  child.stdin.write(
    `${JSON.stringify({
      messages: [{ role: 'user', content: question }],
      mode: 'explore',
      provider: 'test-provider',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: MODEL,
      apiKey: 'test-key',
      pluginRunnerPath: '',
      plugins: [],
      availableExtensions: []
    })}\n`
  );

  const code = await new Promise((resolve) => child.on('close', resolve));
  server.close();
  return { events, requests, code, stderrText };
}

const steeringTexts = (events) =>
  events.filter((event) => event.type === 'steering_applied').map((event) => event.text);

const serialize = (request) => JSON.stringify(request.messages);

describe('main agent steering', () => {
  it(
    'injects a steered message after the tool results of the round in flight',
    async () => {
      const steer = 'only Show HN posts';
      const { events, requests, code, stderrText } = await runTurn([
        async (_body, { send }) => {
          send({ type: 'steer', text: steer });
          // The sidecar has to read the line before the round ends; without a
          // beat the assertion would depend on pipe timing rather than on the
          // steering queue.
          await delay(80);
          return toolRound('search_available_extensions', { query: 'hacker news' });
        },
        () => textRound('Filtered to Show HN.')
      ]);

      expect(stderrText).toBe('');
      expect(code).toBe(0);
      expect(requests).toHaveLength(2);
      // The turn's own prompt must never be mistaken for a queued message.
      expect(steeringTexts(events)).toEqual([steer]);
      expect(serialize(requests[0])).not.toContain(steer);
      expect(serialize(requests[1])).toContain(steer);

      const done = events.at(-1);
      expect(done.type).toBe('done');
      expect(done.text).toBe('Filtered to Show HN.');
    },
    30_000
  );

  it(
    'holds a follow-up back until the agent would otherwise stop',
    async () => {
      const followUp = 'and rank them by score';
      const { events, requests, code } = await runTurn([
        async (_body, { send }) => {
          send({ type: 'follow_up', text: followUp });
          await delay(80);
          return toolRound('search_available_extensions', { query: 'hacker news' });
        },
        () => textRound('Here are the top stories.'),
        () => textRound('Ranked by score.')
      ]);

      expect(code).toBe(0);
      expect(requests).toHaveLength(3);
      // A follow-up is not steering: the tool boundary must pass it by.
      expect(serialize(requests[1])).not.toContain(followUp);
      expect(serialize(requests[2])).toContain(followUp);
      expect(steeringTexts(events)).toEqual([followUp]);
      expect(events.at(-1).text).toBe('Ranked by score.');
    },
    30_000
  );

  it(
    'delivers a message queued while the first round was still streaming',
    async () => {
      const steer = 'keep it to three';
      const { events, requests, code } = await runTurn([
        async (_body, { send }) => {
          send({ type: 'steer', text: steer });
          await delay(80);
          // No tool call: the answer would end here if nothing were queued.
          return textRound('Here is a long list.');
        },
        () => textRound('Three of them, then.')
      ]);

      expect(code).toBe(0);
      expect(requests).toHaveLength(2);
      expect(steeringTexts(events)).toEqual([steer]);
      expect(events.at(-1).text).toBe('Three of them, then.');
    },
    30_000
  );

  it(
    'ignores blank and unknown stdin commands',
    async () => {
      const { events, requests, code } = await runTurn([
        async (_body, { send }) => {
          send({ type: 'steer', text: '   ' });
          send({ type: 'compact' });
          send({ type: 'steer' });
          await delay(80);
          return textRound('Nothing changed.');
        }
      ]);

      expect(code).toBe(0);
      expect(requests).toHaveLength(1);
      expect(steeringTexts(events)).toEqual([]);
      expect(events.at(-1).text).toBe('Nothing changed.');
    },
    30_000
  );
});
