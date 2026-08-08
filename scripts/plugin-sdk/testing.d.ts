export type MockResponseSpec = {
  status?: number;
  body?: unknown;
};

export type MockFetch = {
  calls: string[];
  restore: () => void;
};

export function mockFetch(
  handler: (url: string) => MockResponseSpec | undefined,
): MockFetch;

export function expectToolResult<
  T extends { text?: unknown; references?: unknown; data?: unknown },
>(result: T): T;
