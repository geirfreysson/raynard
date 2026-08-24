export type TimestampedChatMessage = { timestamp: number };

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
