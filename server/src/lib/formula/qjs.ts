// QuickJS in the formula worker (worker.ts; never the API thread): one runtime
// per formula with a memory cap, a small stack (FORMULA_STACK_BYTES says why)
// and a deadline per row. QuickJS sees nothing of the host unless handed it,
// and it's handed nothing: no files, network, process or clock beyond Date.
// The formula is compiled in a scope of its own, so it can't reach the runner
// around it; reassigning a global changes only its own results.
import { readFileSync } from 'fs';
import {
  newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline,
  type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { FORMULA_MEMORY_BYTES, FORMULA_ROW_MS, FORMULA_SETUP_MS, FORMULA_STACK_BYTES } from '../constants-formula';
import type { FormulaOutcome, FormulaRow } from './cells';

export const loadQuickJS = (): Promise<QuickJSWASMModule> => newQuickJSWASMModuleFromVariant(variant);

// The formula doesn't compile: QuickJS's message, for the person.
export class CompileFault extends Error {}
// An exception from the thread itself (its stack overflowing under a deep
// recursion): the WASM instance is unsafe to use or free from then on.
export class HostFault extends Error {}

let lodash: string | null = null;
const lodashSource = (): string => (lodash ??= readFileSync(require.resolve('lodash/lodash.min.js'), 'utf8'));

// The row runner, given the compiled formula f. It keeps its own JSON and
// String, parses the cells formulaRow marked as JSON, and returns the result
// as cell text.
const RUNNER = `(function (f) {
  var parse = JSON.parse, stringify = JSON.stringify, str = String, finite = isFinite, D = Date;
  return function (row) {
    var a = parse(row), v = a.v;
    for (var k = 0; k < a.j.length; k++) { try { v[a.j[k]] = parse(v[a.j[k]]); } catch (e) {} }
    var r = f(v);
    if (r === undefined || r === null) return '';
    if (typeof r === 'string') return r;
    if (typeof r === 'number') return finite(r) ? str(r) : '';
    if (typeof r === 'function' || typeof r === 'symbol') return '';
    if (typeof r !== 'object') return str(r);
    if (r instanceof D) return isNaN(r.getTime()) ? '' : r.toISOString();
    var t = stringify(r);
    return t === undefined ? '' : t;
  };
})`;

function errorText(dumped: unknown): string {
  if (dumped && typeof dumped === 'object' && 'message' in dumped) {
    const d = dumped as { name?: unknown; message?: unknown };
    return `${typeof d.name === 'string' ? d.name : 'Error'}: ${String(d.message)}`;
  }
  return String(dumped);
}

export class QjsSandbox {
  private rt: QuickJSRuntime | null = null;
  private ctx: QuickJSContext | null = null;
  private fn: QuickJSHandle | null = null;

  // Throws CompileFault (the formula doesn't compile) or HostFault.
  constructor(private readonly mod: QuickJSWASMModule, private readonly source: string,
    private readonly usesLodash: boolean) {
    this.build();
  }

  private build(): void {
    const rt = this.mod.newRuntime();
    let ctx: QuickJSContext | null = null;
    try {
      rt.setMemoryLimit(FORMULA_MEMORY_BYTES);
      rt.setMaxStackSize(FORMULA_STACK_BYTES);
      rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + FORMULA_SETUP_MS));
      ctx = rt.newContext();
      if (this.usesLodash) ctx.unwrapResult(ctx.evalCode(lodashSource(), 'lodash.js')).dispose();
      const f = ctx.evalCode(`(function (__v) { return (\n${this.source}\n); })`, 'formula.js');
      if (f.error) {
        const message = errorText(ctx.dump(f.error));
        f.error.dispose();
        ctx.dispose();
        rt.dispose();
        throw new CompileFault(message);
      }
      const make = ctx.unwrapResult(ctx.evalCode(RUNNER, 'runner.js'));
      const runner = ctx.unwrapResult(ctx.callFunction(make, ctx.undefined, f.value));
      make.dispose();
      f.value.dispose();
      Object.assign(this, { rt, ctx, fn: runner });
    } catch (e) {
      if (e instanceof CompileFault) throw e;
      // Lodash or the runner failing, or the thread's own exception: never
      // touch this instance again.
      throw new HostFault(e instanceof Error ? e.message : String(e));
    }
  }

  // host: the thread's own exception; the worker must stop after answering.
  run(row: FormulaRow): { outcome: FormulaOutcome; host?: true } {
    const { rt, ctx, fn } = this;
    if (!rt || !ctx || !fn) return { outcome: { ok: false, error: 'The formula engine stopped', runaway: true } };
    try {
      rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + FORMULA_ROW_MS));
      const arg = ctx.newString(JSON.stringify(row));
      const r = ctx.callFunction(fn, ctx.undefined, arg);
      arg.dispose();
      if (!r.error) {
        const value = ctx.getString(r.value);
        r.value.dispose();
        return { outcome: { ok: true, value } };
      }
      const error = errorText(ctx.dump(r.error));
      r.error.dispose();
      if (error === 'InternalError: interrupted') return this.restart('The formula took too long');
      if (error === 'InternalError: out of memory') return this.restart('The formula used too much memory');
      return { outcome: { ok: false, error, runaway: false } };
    } catch {
      return { outcome: { ok: false, error: 'The formula went too deep', runaway: true }, host: true };
    }
  }

  // After running out of time or memory: a fresh runtime for the next row.
  private restart(error: string): { outcome: FormulaOutcome; host?: true } {
    const outcome: FormulaOutcome = { ok: false, error, runaway: true };
    try {
      this.dispose();
      this.build();
      return { outcome };
    } catch {
      return { outcome, host: true };
    }
  }

  dispose(): void {
    const { fn, ctx, rt } = this;
    Object.assign(this, { rt: null, ctx: null, fn: null });
    fn?.dispose();
    ctx?.dispose();
    rt?.dispose();
  }
}
