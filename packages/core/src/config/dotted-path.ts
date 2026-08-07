/**
 * Dotted-path read/write over a settings object, for `config get`/`config set`.
 *
 * These live in core rather than beside the CLI command so the refusal rule
 * below has one implementation and a test, and so any future surface offering a
 * dotted-path write (a web debug endpoint, a repair command) inherits it instead
 * of re-deriving it.
 */

/**
 * Path segments that are refused outright, in any position.
 *
 * `__proto__` walks to `Object.prototype`; `constructor`/`prototype` walk to the
 * constructor function and its prototype object. Writing through any of them
 * mutates state shared by every object in the process rather than the settings
 * object the user named.
 *
 * WHAT THIS IS AND IS NOT. It is hygiene — defense in depth — not the fix for a
 * live vulnerability. The route was probed against the real settings shape and
 * does NOT currently work: `loadSettings()` runs its result through
 * `normalizeSettings`, which builds `gmail` as an object literal carrying
 * `autoApplyActions` and `autoApplyAcknowledged` as OWN properties, and
 * `saveSettings` writes both keys explicitly. An own property shadows the
 * prototype, so polluting `Object.prototype.autoApplyAcknowledged` and then
 * saving leaves the stored value false. (Verified by running exactly that:
 * `"autoApplyAcknowledged" in gmail` is true either way, but the value read is
 * the own `false`.) The reason the probe fails is a property of a DIFFERENT
 * function — one that materializes every key — so the safety of this one is
 * borrowed, and it stops being true the moment `normalizeSettings` starts
 * omitting a key it considers absent. That is the entire argument for refusing
 * the segments here rather than relying on the shadowing.
 *
 * Refused rather than skipped or sanitized: a `config set` that silently wrote
 * somewhere other than the path the user typed would be worse than an error.
 */
export const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Thrown for a dotted path this module refuses to read or write. */
export class UnsafeConfigPathError extends Error {
  constructor(
    readonly path: string,
    readonly segment: string,
  ) {
    super(
      `Config key "${path}" contains the reserved path segment "${segment}", which addresses the JavaScript prototype chain rather than a setting. Refusing to read or write it.`,
    );
    this.name = "UnsafeConfigPathError";
  }
}

/**
 * Splits a dotted path into segments, refusing any that walks the prototype
 * chain. Every segment is checked, not just the interior ones: a terminal
 * `__proto__` assignment sets the object's prototype rather than binding a
 * property, which is the same class of surprise from the other end.
 */
export function parseConfigPath(path: string): string[] {
  const segments = path.split(".");
  for (const segment of segments) {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new UnsafeConfigPathError(path, segment);
    }
  }
  return segments;
}

/** Reads a nested value by dotted path; `undefined` when any step is absent. */
export function getNestedConfigValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = obj;
  for (const key of parseConfigPath(path)) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Writes a nested value by dotted path, creating intermediate plain objects.
 *
 * Throws `UnsafeConfigPathError` before touching `obj` for a path containing a
 * prototype-chain segment, so a refused write leaves the object untouched.
 */
export function setNestedConfigValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = parseConfigPath(path);
  const last = keys[keys.length - 1];
  if (last === undefined) {
    throw new Error("Config key must not be empty");
  }

  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string;
    const existing = current[key];
    if (existing === undefined || typeof existing !== "object" || existing === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[last] = value;
}
