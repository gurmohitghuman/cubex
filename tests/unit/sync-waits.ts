// This thread's synchronous waits on another thread (Atomics.wait), counted while `fn` runs: the way the server's
// thread could hold the event loop off the CPU for a worker's answer (lib/transform-regex-host.ts answers by message,
// so a regex page never does). A wait takes no CPU time, so a test bounding the thread's CPU (loop-watch.ts cpuMs)
// checks this event too. Not a test itself (no .test.ts).
export async function countSyncWaits<T>(fn: () => Promise<T>): Promise<{ out: T; waits: number }> {
  const wait = Atomics.wait
  let waits = 0
  Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => {
    waits++
    return wait(...args)
  }) as typeof Atomics.wait
  try {
    return { out: await fn(), waits }
  } finally {
    Atomics.wait = wait
  }
}
