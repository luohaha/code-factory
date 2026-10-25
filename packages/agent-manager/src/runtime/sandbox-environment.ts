export type EnvironmentVariablePatch = Readonly<Record<string, string | null>>;

export function environmentVariablePatch(value: unknown): EnvironmentVariablePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('environmentVariables must be an object of string values or null removals');
  }
  const entries = Object.entries(value);
  for (const [name, content] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
      throw new TypeError('Environment variable names must be shell identifiers of at most 128 characters');
    }
    if (content !== null && (typeof content !== 'string' || content.includes('\0'))) {
      throw new TypeError('Environment variable values must be strings without NUL or null removals');
    }
  }
  // Rebuild from entries so special property names remain ordinary data properties.
  return Object.fromEntries(entries) as Record<string, string | null>;
}

export function applyEnvironmentVariablePatch(current: Readonly<Record<string, string>>,
  patch: EnvironmentVariablePatch): Record<string, string> {
  const next = new Map(Object.entries(current));
  for (const [name, value] of Object.entries(environmentVariablePatch(patch))) {
    if (value === null) next.delete(name);
    else next.set(name, value);
  }
  if (next.size > 100 || [...next].reduce((size, [name, value]) =>
    size + Buffer.byteLength(name) + Buffer.byteLength(value), 0) > 65_536) {
    throw new TypeError('Environment variables must contain at most 100 entries and 64 KiB in total');
  }
  return Object.fromEntries(next);
}
