// The /api/v1/hiring create body's filters (routes-fill.ts): those the search
// sends (lib/hiring/filters.ts) and those on Companies (company-filters.ts).
import { z } from 'zod';
import { EMPLOYMENT_TYPES, SENIORITY_LEVELS } from '../lib/hiring/filters';
import { HIRING_MAX_LEFT_OUT, HIRING_MAX_MIN_ROLES } from '../lib/constants';

const words = (what: string) => z.array(z.string()).optional().describe(what);
export const hiringFilterFields = { // lib/hiring/filters.ts
  description_words: words('Only roles whose description mentions any of these words.'),
  leave_out_description_words: words('Leave out roles whose description mentions any of these words.'),
  leave_out_title_words: words('Leave out roles whose title has any of these words.'),
  seniority: z.array(z.enum(SENIORITY_LEVELS)).optional().describe('Only roles at these levels.'),
  employment_types: z.array(z.enum(EMPLOYMENT_TYPES)).optional().describe('Only these employment types.'),
  companies: words('Only roles at these companies, by website, such as ramp.com.'),
  // lib/hiring/company-filters.ts: which companies get a row on Companies; the search stays the same.
  min_roles: z.number().int().min(1).max(HIRING_MAX_MIN_ROLES).optional().describe('Companies with fewer matching '
    + 'roles get no row on Companies. Default 1. Their roles are still searched and paid for.'),
  leave_out_companies: z.array(z.string()).max(HIRING_MAX_LEFT_OUT).optional().describe('These companies, by '
    + 'website, get no row on Companies. Their roles are still searched and paid for.'),
};
