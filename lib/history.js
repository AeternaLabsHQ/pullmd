/**
 * Recent-conversion listing shared by GET /api/history and the MCP
 * list_recent tool, so both apply the same scope:
 *   - signed-in caller: their own conversions only
 *   - anonymous caller (auth disabled) with public history off: denied
 *   - anonymous caller otherwise: the shared history
 */
export const PUBLIC_HISTORY_DISABLED = 'Public history is disabled on this instance.';

export function recentHistory({ cache, user, disablePublicHistory, limit }) {
  if (disablePublicHistory && !user) return { denied: true, items: [] };
  if (!cache) return { denied: false, items: [] };
  const items = user ? cache.historyForUser(user.id, limit) : cache.history(limit);
  return { denied: false, items };
}
