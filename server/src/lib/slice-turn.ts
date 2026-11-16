// One bulk writer's slice a turn of the event loop, across every writer on the server's thread (lib/bulk-slices.ts):
// three formulas following one write at once, a follow beside an undo. Each writer yields before its slice, but
// writers woken in the same turn then ran their slices back to back, nothing served between: 3 formulas following
// 25,000 rows held the server 134 to 187 ms with slices of 50 to 76 ms. Now a slice takes the turn, and the next one
// (any writer's) waits until the event loop has polled for requests since it was written.
let gate: Promise<void> = Promise.resolve();

// Waits for the turn, then holds it: call the answer once the slice is written (in a finally).
export async function takeSliceTurn(): Promise<() => void> {
  for (;;) {
    const seen = gate;
    await seen;
    // Several waiters wake on the same gate: the first takes it, the others wait for the new one.
    if (seen === gate) break;
  }
  let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
  // An immediate set in the poll phase (a slice written after the checkpoint worker's answer) runs before the next
  // poll; the one it sets runs after it.
  return () => { setImmediate(() => setImmediate(release)); };
}
