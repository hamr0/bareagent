'use strict';

/**
 * BA-29 — `Loop({ checkArgs: true })`: a tiny, dependency-free, TOP-LEVEL argument check against a tool's
 * declared `parameters` (JSON-Schema-shaped). It exists for one failure: a model that sends the wrong
 * JSON TYPE for a param (an object where a string is declared — seen live on a compat server) or drops a
 * required one. The tool is not executed; the refusal goes back to the model through the same path as a
 * tool throw, so `maxIdenticalToolErrors` still bounds it.
 *
 * Deliberately NOT a schema validator: no nested schemas, no `$ref`/`oneOf`/`enum`/`format`, no coercion.
 * A `type` this file does not know (or none) is SKIPPED, never guessed. `type` may be an array = any-of.
 * `integer` is `Number.isInteger`. `null` is its own type, `"null"`. Only the FIRST fault is reported
 * (required-missing first, in `required` order; then type mismatches in `properties` order).
 */

const KNOWN = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

/** JSON type name of a parsed value. @param {any} v @returns {string} */
function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** @param {any} v @param {string} type */
function matches(v, type) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    default: return false;
  }
}

/**
 * @typedef {{ kind: 'arg-type'|'arg-missing', param: string, expected?: string, got: string, message: string }} ArgFault
 */

/**
 * @param {{ parameters?: any }} tool
 * @param {any} args - the parsed arguments (anything; a non-object is read as having no params)
 * @returns {ArgFault|null} the first fault, or null when the call is fine / unchecked
 */
function checkToolArgs(tool, args) {
  const schema = tool && tool.parameters;
  if (!schema || typeof schema !== 'object') return null;
  const obj = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const own = (/** @type {any} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);
  /** @param {string} p */
  const declared = (p) => {
    const t = own(props, p) && props[p] ? props[p].type : undefined;
    const list = Array.isArray(t) ? t : typeof t === 'string' ? [t] : null;
    return list && list.length > 0 && list.every((x) => typeof x === 'string' && (KNOWN.has(x) || x === 'null')) ? list : null;
  };

  if (Array.isArray(schema.required)) {
    for (const p of schema.required) {
      if (typeof p !== 'string') continue;
      if (!own(obj, p) || obj[p] === undefined) {
        const t = declared(p);
        return { kind: 'arg-missing', param: p, ...(t && { expected: t.join(' or ') }), got: 'undefined', message: `${p} is required` };
      }
    }
  }
  for (const p of Object.keys(props)) {
    if (!own(obj, p) || obj[p] === undefined) continue; // absent + optional ⇒ fine
    const list = declared(p);
    if (!list) continue; // unknown/absent type ⇒ skip
    const v = obj[p];
    if (list.some((t) => (t === 'null' ? v === null : matches(v, t)))) continue;
    const got = jsonType(v);
    const expected = list.join(' or ');
    const encode = list.length === 1 && list[0] === 'string' && (got === 'object' || got === 'array')
      ? '; to send JSON, encode it as one string' : '';
    return { kind: 'arg-type', param: p, expected, got, message: `${p} must be a ${expected}, got ${got}${encode}` };
  }
  return null;
}

module.exports = { checkToolArgs, jsonType };
