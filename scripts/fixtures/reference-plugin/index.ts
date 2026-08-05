import { formatExample } from './client.ts';

export const tools = {
  lookupExample: {
    description: 'Look up one record from the example API by numeric ID.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'integer',
          description: 'Example record ID.'
        }
      }
    },
    card: {
      name: { singular: 'example', plural: 'examples' },
      title: '{{name}} (#{{id}})',
      layout: [{ component: 'KeyValue', pairs: [{ label: 'Name', field: 'name' }] }]
    },
    async execute(args: { id: number }) {
      return {
        text: formatExample(args.id),
        data: { id: args.id, name: `Example ${args.id}` },
        references: [
          {
            title: `Example ${args.id}`,
            url: `https://api.example.com/items/${args.id}`,
            expandedContent: {
              id: args.id,
              name: `Example ${args.id}`
            }
          }
        ]
      };
    }
  }
};

export default { tools };
