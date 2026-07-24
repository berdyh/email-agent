/**
 * Extract the `id` field from an action plugin's source code.
 *
 * Shared between the save route (built-in conflict detection) and the
 * action-chat hook (deriving a filename) so both agree on how an action id is
 * recognized in `.action.ts` source.
 */
export function extractActionId(source: string): string | null {
  const match = source.match(/id:\s*["'`]([^"'`]+)["'`]/);
  return match?.[1] ?? null;
}
