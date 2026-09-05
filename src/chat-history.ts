export type TimestampedChatMessage = { timestamp: number };
export type UpdatedChat = { chatId: string; updatedAt: string };

/** Newest saved conversation first, with invalid legacy dates at the end. */
export function orderChatsByUpdatedAt<T extends UpdatedChat>(chats: readonly T[]): T[] {
  return [...chats].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid && leftTime !== rightTime) return rightTime - leftTime;
    if (leftValid !== rightValid) return rightValid ? 1 : -1;
    return left.chatId.localeCompare(right.chatId);
  });
}

/** Apply a completed save to the sidebar without waiting for another index read. */
export function upsertChatByUpdatedAt<T extends UpdatedChat>(chats: readonly T[], row: T): T[] {
  return orderChatsByUpdatedAt([...chats.filter((chat) => chat.chatId !== row.chatId), row]);
}

/**
 * Chat ordering follows the newest real transcript entry, not the last time the
 * file happened to be opened or rewritten.
 */
export function latestChatTurnIso(
  messages: readonly TimestampedChatMessage[],
  fallbackIso: string
): string {
  const latestTimestamp = messages.reduce(
    (latest, message) =>
      Number.isFinite(message.timestamp) && message.timestamp > latest
        ? message.timestamp
        : latest,
    0
  );
  if (!latestTimestamp) return fallbackIso;
  const latest = new Date(latestTimestamp);
  return Number.isNaN(latest.getTime()) ? fallbackIso : latest.toISOString();
}
