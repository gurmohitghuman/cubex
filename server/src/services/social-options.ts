// What the app's New social research dialog offers (a read of treg's catalog,
// cached as every catalog read is): each platform whose search Cubex can add
// rows from now, with what one search costs at most, and what each step costs
// a post at most (null: it can't be set up now, or has no known price; the AI
// breakdown is priced by the model it runs on, so it has none here). A
// platform treg stops serving isn't offered. Each price is the most its run
// lets a row cost (the cap it sends treg), worked out by the same builder the
// table's runs use: a routed tool's own list price can be far below that (a
// provider the step is held to, or the dearest a routed step can reach).
import { PLATFORMS, PLATFORM_SPECS, type Platform } from '../lib/social/platforms';
import { SOCIAL_POSTS_PER_SEARCH, type SocialInput } from '../lib/social/input';
import { addsRows, getTool } from './enrich-catalog';
import { postsColumnsOf } from './social-create';
import { buildSocialRuns, type BuiltRun, type PlatformRuns } from './social-steps';

type PricedStep = 'transcript' | 'creator' | 'comments';
export interface SocialPlatformOption {
  platform: Platform; label: string; searchUsd: number | null;
  steps: { transcript: number | null; creator: number | null; comments: number | null };
}

const capOf = (run: BuiltRun | null | undefined): number | null => run?.config.enrichment.maxCostPerRowUsd ?? null;

// One step's runs on this platform alone (with the search), as a table made with only that step would have them.
async function builtWith(platform: Platform, step: PricedStep | null): Promise<PlatformRuns | null> {
  const input: SocialInput = {
    topic: 'x', searches: ['x'], platforms: [platform], steps: step ? [step] : [], minViews: null,
    minComments: null, postedWithinDays: null, perSearch: SOCIAL_POSTS_PER_SEARCH,
  };
  const runs = await buildSocialRuns(input, { [platform]: postsColumnsOf(platform, input) } as Record<Platform,
    string[]>);
  return 'ok' in runs ? runs.ok[0] : null;
}

export async function socialOptions(): Promise<SocialPlatformOption[]> {
  const out: SocialPlatformOption[] = [];
  for (const platform of PLATFORMS) {
    const spec = PLATFORM_SPECS[platform];
    const search = await getTool(spec.search.toolId);
    if (!('ok' in search) || !(await addsRows(search.ok))) continue;
    const [alone, transcript, creator, comments] = await Promise.all([builtWith(platform, null),
      builtWith(platform, 'transcript'), spec.creator ? builtWith(platform, 'creator') : null,
      builtWith(platform, 'comments')]);
    out.push({
      platform, label: spec.label, searchUsd: capOf(alone?.search),
      steps: {
        transcript: capOf(transcript?.transcript), creator: spec.creator ? capOf(creator?.creator) : 0,
        comments: capOf(comments?.comments),
      },
    });
  }
  return out;
}
