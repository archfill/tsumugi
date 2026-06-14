/**
 * ID generation helpers.
 * Uses crypto.randomUUID() (UUID v4) to avoid extra dependencies.
 */

export function newId(prefix?: string): string {
  const uuid = crypto.randomUUID();
  return prefix ? `${prefix}_${uuid}` : uuid;
}
