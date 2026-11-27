// Positive integer from the environment, else the fallback. A garbage value must
// not become NaN: several consumers treat NaN as "no limit". Shared by
// constants.ts and its split-out siblings (constants-enrich.ts).
export const envInt = (name: string, fallback: number): number => {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
};

// A count from the environment where 0 means none (a whole number 0 or more), else the fallback.
export const envCount = (name: string, fallback: number): number => {
  const raw = (process.env[name] ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : fallback;
};

// The longest wait Node's timers keep (2^31-1 ms, about 24.8 days): a longer one fires at once.
export const TIMER_MAX_MS = 2_147_483_647;
const capped = new Set<string>();
// A millisecond setting: as envInt, at most TIMER_MAX_MS. A larger value (say, a year) would fire at once, or wrap a
// server timeout to Node's default, so it is held at the most a timer can wait, and the log says so once.
export const envMs = (name: string, fallback: number): number => {
  const ms = envInt(name, fallback);
  if (ms <= TIMER_MAX_MS) return ms;
  if (!capped.has(name)) {
    capped.add(name);
    console.warn(`${name} is longer than the longest wait Node can keep: using ${TIMER_MAX_MS} ms (about 24.8 days).`);
  }
  return TIMER_MAX_MS;
};
