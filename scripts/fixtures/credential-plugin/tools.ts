import { apiGet, createApiReference, defineTools, requireCredential } from '@raynard/plugin-sdk';

export const tools = defineTools({
  credential_lookup: {
    description: 'Fetch one authenticated fixture URL using a host-supplied API key.',
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
      // Read the credential inside execute, never at module load, so tool
      // discovery keeps working before the user has added a key.
      const apiKey = requireCredential('FIXTURE_API_KEY', 'Fixture API key');
      const payload = await apiGet(String(args.url), { query: { apikey: apiKey } });
      return {
        text: `${String(payload.value)} (key ${apiKey})`,
        data: payload,
        references: [
          createApiReference({
            id: 'credential-fixture',
            label: 'Credential fixture',
            sourceUrl: String(args.url),
            quote: String(payload.value),
            payload,
          }),
        ],
      };
    },
  },
});
