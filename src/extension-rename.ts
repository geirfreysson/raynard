// Renaming an extension changes only its display name. The directory slug is
// what the agent routes on, what chats persist as `activeBuildPlugin.dir`, and
// what the catalog matches an install against, so it deliberately stays put.

export type RenameableExtension = {
  id: string;
  name: string;
  directory: string;
};

export type ExtensionRenameResult =
  | { ok: true; name: string; changed: boolean }
  | { ok: false; error: string };

export const EXTENSION_NAME_MAX_LENGTH = 64;

function directorySlug(directory: string): string {
  return (
    String(directory || '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) ?? ''
  );
}

/** Collapses whitespace so two names cannot differ only by spacing. */
export function normalizeExtensionName(raw: string): string {
  return String(raw ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `resolve_generated_plugin_by_id` accepts an id, a directory name, or a
 * case-insensitive display name, so a name colliding with any of those on
 * another extension would make resolution ambiguous rather than merely ugly.
 */
export function validateExtensionRename(
  raw: string,
  target: RenameableExtension,
  others: RenameableExtension[]
): ExtensionRenameResult {
  const name = normalizeExtensionName(raw);
  if (!name) return { ok: false, error: 'Enter a name for this extension.' };
  if (name.length > EXTENSION_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Keep the name to ${EXTENSION_NAME_MAX_LENGTH} characters or fewer.`
    };
  }

  const lowered = name.toLowerCase();
  const collides = others.some(
    (other) =>
      other.id !== target.id &&
      (other.name.trim().toLowerCase() === lowered ||
        other.id.trim().toLowerCase() === lowered ||
        directorySlug(other.directory).toLowerCase() === lowered)
  );
  if (collides) return { ok: false, error: 'Another extension already uses that name.' };

  return { ok: true, name, changed: name !== target.name };
}
