// A list's items once each (case ignored, the first spelling kept), up to a cap
// (pure). For the lists a request sends to make something: role titles,
// questions. Each item is looked up in a Set, and the cap is checked as items
// come in, so a request listing many items costs one pass over them, never a
// scan of every kept item for each one.
export class DistinctItems {
  readonly items: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly max: number) {}

  // Keeps s unless it's in already (case ignored). false: it would be one more
  // than the cap, and nothing was kept (the caller refuses the list).
  add(s: string): boolean {
    const key = s.toLowerCase();
    if (this.seen.has(key)) return true;
    if (this.items.length >= this.max) return false;
    this.seen.add(key);
    this.items.push(s);
    return true;
  }
}
