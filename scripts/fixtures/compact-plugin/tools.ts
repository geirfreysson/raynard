import {
  createApiReference,
  defineTools,
} from '@raynard/plugin-sdk';

export const tools = defineTools({
  compact_lookup: {
    description: 'Look up one compact fixture record by numeric id.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer', description: 'Record id.' },
      },
      additionalProperties: false,
    },
    card: {
      name: { singular: 'record', plural: 'records' },
      title: '{{label}}',
      layout: [
        { component: 'KeyValue', pairs: [{ label: 'ID', field: 'id' }] },
      ],
    },
    async execute(args) {
      const id = Number(args.id);
      const label = `Record ${id}`;
      return {
        text: label,
        data: { id, label },
        references: [
          createApiReference({
            id: String(id),
            label,
            sourceUrl: `https://api.example.com/records/${id}`,
            quote: label,
            payload: { id, label },
          }),
        ],
      };
    },
  },
});
