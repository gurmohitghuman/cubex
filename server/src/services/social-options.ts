// What the app's New social research dialog offers (a read of treg's catalog,
// cached as every catalog read is): each platform whose search Cubex can add
// rows from now, with what one search costs, and what each step costs a post
// on it (null: no price known; the AI breakdown is priced by the model it
// runs on, so it has none here). A platform treg stops serving isn't offered.
import { PLATFORMS, PLATFORM_SPECS, type Platform } from '../lib/social/platforms';
import { addsRows, getTool } from './enrich-catalog';
import type { EnrichTool } from '../lib/enrich-tool';

export interface SocialPlatformOption {
  platform: Platform; label: string; searchUsd: number | null;
  steps: { transcript: number | null; creator: number | null; comments: number | null };
}

const priceOf = (t: EnrichTool | null): number | null => (t?.price && typeof t.price.usd === 'number' ? t.price.usd
  : null);

async function tool(id: string): Promise<EnrichTool | null> {
  const t = await getTool(id);
  return 'ok' in t ? t.ok : null;
}

export async function socialOptions(): Promise<SocialPlatformOption[]> {
  const out: SocialPlatformOption[] = [];
  for (const platform of PLATFORMS) {
    const spec = PLATFORM_SPECS[platform];
    const search = await tool(spec.search.toolId);
    if (!search || !(await addsRows(search))) continue;
    const [transcript, creator, comments] = await Promise.all([tool(spec.transcript.toolId),
      spec.creator ? tool(spec.creator.toolId) : Promise.resolve(null), tool(spec.comments.toolId)]);
    out.push({
      platform, label: spec.label, searchUsd: priceOf(search),
      steps: {
        transcript: priceOf(transcript), creator: spec.creator ? priceOf(creator) : 0, comments: priceOf(comments),
      },
    });
  }
  return out;
}
