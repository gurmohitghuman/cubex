// How a tool declares the shape of its structuredContent (outputSchema). Written with zod and handed to the
// SDK's own registerTool (tool-helpers.ts), so tools/list publishes it and the SDK checks every result
// against it before answering. Published open: an object may carry keys its schema doesn't name, so a
// client that checks results itself never refuses a result for a field added later. In e2e
// (CUBEX_TEST_STRICT_OUTPUT, scripts/e2e-env.mjs) every object refuses such keys instead, so a result that
// grew a field fails the spec that reads it until its schema names it.
import { z } from 'zod';
import type { ToolResult } from './tool-helpers';

export const STRICT_OUTPUT = process.env.CUBEX_TEST_STRICT_OUTPUT === '1';

// An object of the answer. Strict in e2e, else unknown keys pass (zod's default).
export const obj = <T extends z.ZodRawShape>(shape: T): z.ZodObject<T> =>
  (STRICT_OUTPUT ? z.strictObject(shape) : z.object(shape)) as unknown as z.ZodObject<T>;

// An object whose named keys always hold these types, and that carries other keys by case (a run's kind,
// a column's kind): never strict, even in e2e.
export const open = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

// An object keyed by names people choose (columns, groups): any key, values of one shape.
export const keyed = <T extends z.ZodType>(value: T) => z.record(z.string(), value);

// What a handler's answer must be to fit a schema (registerTool checks it at compile time): zod's input
// type with the "any other key" of open, keyed and info objects left out, since an interface has no index
// signature. Every named field is checked, null and absent included; an info or keyed value is any object
// but a list (a list is an object to the compiler), and zod refuses a list there as it does text or a number.
export type Fits<T> = T extends readonly (infer E)[] ? Fits<E>[]
  : T extends object ? (string extends keyof T ? Named<T> & AnObject : Named<T>) : T;
type Named<T> = { [K in keyof T as string extends K ? never : K]: Fits<T[K]> };
type AnObject = object & { [Symbol.iterator]?: never };

type Json = Record<string, unknown>;
const isEmpty = (v: unknown) => !!v && typeof v === 'object' && Object.keys(v).length === 0;
const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// The published JSON Schema: no additionalProperties false (open objects, as above), none that allows
// anything or says keys are text (they always are), and no $schema (an
// outputSchema without one is JSON Schema 2020-12); a choice of plain types ("a string or null") is written
// as one type list. Keys inside properties are names, never keywords.
function published(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(published);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === '$schema' || (k === 'additionalProperties' && (v === false || isEmpty(v)))) continue;
    if (k === 'propertyNames' && isEqual(v, { type: 'string' })) continue;
    out[k] = k === 'properties' && v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Json).map(([name, s]) => [name, published(s)]))
      : published(v);
  }
  const plain = Array.isArray(out.anyOf) && (out.anyOf as Json[]).every(b =>
    b && typeof b.type === 'string' && Object.keys(b).length === 1);
  if (plain) {
    const { anyOf, ...rest } = out;
    return { type: (anyOf as Json[]).map(b => b.type), ...rest };
  }
  return out;
}

interface JsonSchemaOptions { target: string }
type Converter = (o: JsonSchemaOptions) => Json;

// The schema as the SDK takes it: a Standard Schema that validates with zod and converts to JSON Schema
// through published() above. One per tool, its JSON made once: a server is built for every request.
// Outside e2e an answer that doesn't fit is logged and passes: the call has already done its work, so it
// must never come back as a failure (the SDK would turn it into one). In e2e it fails the call.
const made = new Map<string, object>();
const logged = new Set<string>();
export function toolOutput(name: string, schema: z.ZodObject<any, any>): object {
  const known = made.get(name);
  if (known) return known;
  const std = schema['~standard'] as unknown as {
    validate: (v: unknown) => { issues?: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }> };
    jsonSchema: { input: Converter; output: Converter };
  };
  const json = new Map<string, Json>();
  const convert = (io: 'input' | 'output', o: JsonSchemaOptions): Json => {
    const key = `${io} ${o.target}`;
    if (!json.has(key)) json.set(key, published(std.jsonSchema[io](o)) as Json);
    return structuredClone(json.get(key)!);
  };
  const validate = (value: unknown) => {
    const result = std.validate(value);
    if (STRICT_OUTPUT || !result.issues) return result;
    // Array positions read as [] so each misfit logs once per process, at most 500 kinds of them.
    const at = (path: ReadonlyArray<unknown> = []) =>
      path.map(p => (typeof p === 'number' ? '[]' : String(p))).join('.');
    const why = result.issues.map(i => `${at(i.path)}: ${i.message}`).join('; ');
    if (!logged.has(`${name} ${why}`) && logged.size < 500) {
      logged.add(`${name} ${why}`);
      console.warn(`MCP tool ${name}: its answer does not fit its outputSchema (answered anyway): ${why}`);
    }
    return { value };
  };
  const wrapped = {
    '~standard': {
      version: 1, vendor: 'cubex', validate,
      jsonSchema: {
        input: (o: JsonSchemaOptions) => convert('input', o), output: (o: JsonSchemaOptions) => convert('output', o),
      },
    },
  };
  made.set(name, wrapped);
  return wrapped;
}

// The SDK checks only results that are not errors, but a 2025-era client also checks an error's
// structuredContent against the schema (transform_column's stopped pass carries one). In e2e such an error
// that doesn't fit fails the call, as a result that doesn't fit does.
export function checkErrorOutput(
  name: string, schema: z.ZodObject<any, any>, handler: (args: any, mcp: any) => Promise<ToolResult>,
) {
  if (!STRICT_OUTPUT) return handler;
  return async (args: any, mcp: any): Promise<ToolResult> => {
    const result = await handler(args, mcp);
    if (!result.isError || result.structuredContent === undefined) return result;
    const parsed = schema.safeParse(result.structuredContent);
    if (parsed.success) return result;
    const why = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return { content: [{ type: 'text', text: `Output validation error: ${name}'s error result: ${why}` }],
      isError: true };
  };
}
