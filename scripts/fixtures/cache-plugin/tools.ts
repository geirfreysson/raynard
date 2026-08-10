import { apiGet, createApiReference, defineTools } from '@raynard/plugin-sdk';

export const tools = defineTools({
  cached_lookup: {
    description: 'Fetch one cache integration fixture URL.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' } },
      additionalProperties: false,
    },
    card: {
      name: { singular: 'result', plural: 'results' },
      layout: [{ component: 'Json' }],
    },
    async execute(args) {
      const payload = await apiGet(String(args.url));
      return {
        text: String(payload.value),
        data: payload,
        references: [
          createApiReference({
            id: 'cache-fixture',
            label: 'Cache fixture',
            sourceUrl: String(args.url),
            quote: String(payload.value),
            payload,
          }),
        ],
      };
    },
  },
});
