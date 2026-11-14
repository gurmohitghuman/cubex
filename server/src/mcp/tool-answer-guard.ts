// Typecheck-only guards for registerTool's answer check (tool-helpers.ts, tool-outputs.ts ToolAnswer): each
// line stops compiling if the check starts letting through what it refuses today. Types only: nothing imports
// this file, and it builds to nothing.
import type { ok, OkResult, ToolHandlerFor } from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';

type Expect<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
type Refused<A, B> = Fits<A, B> extends true ? false : true;
type IsNever<T> = [T] extends [never] ? true : false;
// What ok() takes for an answer of type T: never when T isn't typed field by field.
type Takes<T extends object> = Parameters<typeof ok<T>>[0];
type Answer<T> = Promise<OkResult<T>>;
type Handler = ReturnType<ToolHandlerFor<'get_version'>>;
type Version = ToolAnswer<'get_version'>;

export type AnswerGuards = [
  Expect<Fits<Answer<Version>, Handler>>,
  // A field of the wrong type, null where the schema allows none, and a required field left out.
  Expect<Refused<Answer<Omit<Version, 'update_check'> & { update_check: string }>, Handler>>,
  Expect<Refused<Answer<Omit<Version, 'update_check'> & { update_check: null }>, Handler>>,
  Expect<Refused<Answer<Omit<Version, 'update_check'>>, Handler>>,
  // An answer typed as any, object or an object of any keys.
  Expect<IsNever<Takes<any>>>,
  Expect<IsNever<Takes<object>>>,
  Expect<IsNever<Takes<Record<string, unknown>>>>,
];
