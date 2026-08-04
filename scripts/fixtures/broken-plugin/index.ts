// Non-conforming plugin: the tool method is named `handler` instead of the
// required `execute`. Used to prove the runner reports it as not callable and
// refuses to invoke it.
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
    async handler(args: { id: number }) {
      return {
        text: `Example ${args.id}`,
        references: []
      };
    }
  }
};

export default { tools };
