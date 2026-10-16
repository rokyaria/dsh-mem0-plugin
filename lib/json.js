/**
 * Lossless-JSON projection for tool results.
 *
 * mem0 returns plain objects that carry explicit `undefined` members (e.g. an
 * unset `updatedAt`) and may hand back `Date` instances. `JSON.stringify`
 * silently drops both, but the dsh tool runtime validates the canonical value
 * *structurally* and rejects anything that is not lossless JSON
 * ("value is not lossless JSON"). Every tool result therefore passes through
 * {@link toJsonValue} before it leaves `execute`.
 *
 * @module dsh-mem0-plugin/json
 */
function isPlainObject(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
/**
 * Drop `undefined`, replace non-finite numbers with `null`, stringify `Date`,
 * and rebuild the value from plain objects and arrays only.
 *
 * Keys whose value is `undefined` are omitted rather than nulled, matching what
 * `JSON.stringify` would produce, so rendered output is unchanged.
 */
export function toJsonValue(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint')
        return value.toString();
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value))
        return value.map((item) => toJsonValue(item));
    if (isPlainObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined)
                continue;
            out[key] = toJsonValue(item);
        }
        return out;
    }
    // Anything else (class instances, functions, symbols) has no lossless JSON
    // form; surface it as its string rendering instead of failing the call.
    return String(value);
}
