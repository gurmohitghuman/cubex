// Positive integer from the environment, else the fallback. A garbage value must
// not become NaN: several consumers treat NaN as "no limit". Shared by
// constants.ts and its split-out siblings (constants-enrich.ts).
export const envInt = (name: string, fallback: number): number => {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
};
