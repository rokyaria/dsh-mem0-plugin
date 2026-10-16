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
/** JSON value shape accepted by `output.schema: { type: 'json' }`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/**
 * Drop `undefined`, replace non-finite numbers with `null`, stringify `Date`,
 * and rebuild the value from plain objects and arrays only.
 *
 * Keys whose value is `undefined` are omitted rather than nulled, matching what
 * `JSON.stringify` would produce, so rendered output is unchanged.
 */
export declare function toJsonValue(value: unknown): JsonValue;
