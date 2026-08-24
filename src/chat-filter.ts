export function filterChatsByName<T extends { name: string }>(chats: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return chats;

  return chats.filter((chat) => chat.name.toLocaleLowerCase().includes(normalizedQuery));
}
