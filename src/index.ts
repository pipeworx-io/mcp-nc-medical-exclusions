interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
/**
 * NC Medicaid (Division of Health Benefits, Office of Compliance and
 * Program Integrity) State Excluded Providers List screening — fleet
 * #3282, the ninth state exclusion pack after mcps/ny-omig-exclusions
 * (#2788), mcps/ca-medical-exclusions (#2805), mcps/tx-medical-exclusions
 * (#2809), mcps/fl-medical-exclusions, mcps/pa-medical-exclusions (#3277),
 * mcps/ga-medical-exclusions (#3279), mcps/oh-medical-exclusions (#3278)
 * and mcps/nj-medical-exclusions (#3281).
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal
 * exclusions list, North Carolina runs its own Medicaid exclusion list
 * through NC Medicaid's Office of Compliance and Program Integrity:
 * entities and individuals excluded from North Carolina's Medicaid and
 * other Health Programs. This is that list, for North Carolina only —
 * one pack per jurisdiction (root CLAUDE.md rule 5).
 *
 * SOURCE AND SHAPE. NC Medicaid's "Excluded Providers" page
 * (https://medicaid.ncdhhs.gov/providers/excluded-providers) links a
 * stable, unauthenticated download alias (no login, no CAPTCHA, verified
 * live 2026-10-18): a plain GET to
 * https://medicaid.ncdhhs.gov/nc-medicaid-state-excluded-provider-list/download?attachment
 * returning a 200 Excel 2007+ (.xlsx) file, 181 data rows at capture time.
 * See scripts/bake-index.mjs for the full column layout and the
 * mixed-date-format handling the source file itself requires.
 *
 * Root CLAUDE.md's standing rule 3 still applies regardless of
 * reachability: a baked table never sits in gateway module scope. It is
 * baked into src/nc-dhb-index-data.ts, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy,
 * and injected here as `args._bakedIndex` — same pattern as the eight
 * precedent packs (fleet #2754).
 *
 * This is an official North Carolina State public enforcement record that
 * NC Medicaid's Office of Compliance and Program Integrity publishes
 * specifically so providers, payers and the public can screen against it —
 * baking a copy needs no reuse grant, same footing as the federal LEIE and
 * the eight precedent state packs.
 *
 * NO HOME ADDRESS — this source carries no street address at all for any
 * row (nothing to withhold there). CITY/STATE/ZIP is the provider's
 * registered location, served at the same coarse grain
 * ga-medical-exclusions serves its STATE field — never a street-level
 * address, matching root CLAUDE.md's personal-data carve-out and the task
 * that filed this pack. OWNERSHIP is a name only, never an address.
 *
 * OWNERSHIP IS NOT AN EXCLUSION — NC Medicaid's own published caveat:
 * "The name(s) in the OWNERSHIP column are not excluded unless listed
 * under EXCLUDED ENTITY." A name query that matches only the ownership
 * field of a row (never the excluded_entity field) is reported as
 * `match_type: "ownership_only_match"`, with `excluded: false` and an
 * explicit statement that this person/entity is NOT itself excluded —
 * never conflated with an identification.
 *
 * NO DERIVED STATUS — UNLIKE TX/PA/NJ'S "EVER EXCLUDED" MODEL, THIS LIST
 * IS A CURRENT SNAPSHOT. NC Medicaid publishes no end/reinstatement date;
 * a provider simply disappears from the next monthly file once reinstated
 * (same construction as ga-medical-exclusions). So `currently_excluded` is
 * `true` for every row this pack serves — there is no ended/
 * status-unknown state to derive, and this pack says so rather than
 * inventing one.
 *
 * NPI/ATYPICAL ID IS NOT ALWAYS AN NPI — checked directly against the
 * upstream data: most identifier-bearing rows carry a well-formed 10-digit
 * NPI, but a minority carry an 8-digit non-NPI "atypical" Medicaid
 * provider ID instead (NC Medicaid's own column header, "NPI/ATYPICAL ID
 * (EXCLUDED)", names this possibility). `npi` and `atypical_id` are kept
 * as separate fields rather than merged, so a caller always knows which
 * kind of identifier it has.
 *
 * MATCHING MODEL, same discipline as every precedent pack: an NPI or
 * atypical-ID match identifies a specific excluded provider (both are
 * exact, provider-specific identifiers in this data). A name match against
 * the EXCLUDED ENTITY field — even an exact one — is a CANDIDATE, never an
 * identification: this list has no date of birth, and common names can
 * repeat.
 *
 * Keyless.
 */
import type { NcDhbRow } from './nc-dhb-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the baked table is injected by the
// gateway as `args._bakedIndex`, loaded from KV once per isolate. NEVER
// value-import ./nc-dhb-index-data.js here — only the type-only import
// above, which is erased at compile time. A value import puts the whole
// table back in the bundle and into every isolate's heap;
// scripts/check-gateway-bundle-size.mjs fails the deploy if that happens.
let ROWS: NcDhbRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let LISTING_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.NC_DHB_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no match found"
    // from an empty table would be a silent wrong answer, indistinguishable
    // from a real clean screening result.
    throw new Error(
      `nc-medical-exclusions: the baked NC Medicaid State Excluded Providers List index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as NcDhbRow[];
  DATA_AS_OF = String(idx?.NC_DHB_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.NC_DHB_SOURCE_URL ?? 'https://medicaid.ncdhhs.gov/nc-medicaid-state-excluded-provider-list/download?attachment');
  LISTING_URL = String(idx?.NC_DHB_LISTING_URL ?? 'https://medicaid.ncdhhs.gov/providers/excluded-providers');
  CAPTURED_AT = String(idx?.NC_DHB_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.NC_DHB_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'NC Medicaid, Division of Health Benefits, Office of Compliance and Program Integrity — State Excluded Providers List';

const SNAPSHOT_CAVEAT =
  'NC Medicaid publishes this as a current snapshot, not an ever-excluded history — there is no end/reinstatement date column, and a provider simply disappears from the next monthly file once reinstated. Every row this pack serves is therefore currently_excluded:true; there is no ended or status-unknown state to derive.';

const OWNERSHIP_CAVEAT =
  'NC Medicaid\'s own published note: the name(s) in the OWNERSHIP column are NOT excluded unless separately listed under EXCLUDED ENTITY. An ownership_only_match means this name appears only as a listed owner/principal of an excluded business — it is not, by itself, an exclusion of that person.';

const NOT_AN_ANSWER =
  'Name matches against the excluded entity are CANDIDATES, not identifications — this list has no date of birth to tell same-named providers apart. Only an NPI or atypical-ID match identifies a specific excluded provider. Confirm a name match against one of those before acting on it.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

type MatchType = 'npi_match' | 'atypical_id_match' | 'name_candidate_exact' | 'name_candidate_partial' | 'ownership_only_match';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly against this excluded provider\'s listed NPI. An NPI identifies one provider, so this is an identification.',
  atypical_id_match: 'The atypical (non-NPI) Medicaid provider ID matched exactly. This ID identifies one provider in NC Medicaid\'s own system, so this is an identification.',
  name_candidate_exact: 'The name matched exactly against the EXCLUDED ENTITY field, but this list has no date of birth to confirm it is the same person or entity — names can repeat. Confirm with an NPI or atypical ID before acting.',
  name_candidate_partial: 'The name is a partial/substring match against the EXCLUDED ENTITY field, not exact. Treat as a lead to check, not a finding. Confirm with an NPI or atypical ID.',
  ownership_only_match: 'The name matched the OWNERSHIP field of this row, NOT the EXCLUDED ENTITY field. Per NC Medicaid\'s own published note, an ownership name is NOT itself excluded unless it also appears as its own excluded_entity row. This is NOT an identification of an exclusion.',
};

function shape(r: NcDhbRow, matchType: MatchType) {
  const excludedAsEntity = matchType !== 'ownership_only_match';
  return {
    excluded_entity: r.excluded_entity,
    npi: r.npi,
    atypical_id: r.atypical_id,
    is_npi: Boolean(r.npi),
    reason_for_exclusion: r.reason_for_exclusion,
    city: r.city,
    state: r.state,
    zip_code: r.zip_code,
    ownership: r.ownership,
    currently_excluded: true,
    effective_date: r.effective_date,
    excluded: excludedAsEntity,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const atypicalIdRaw = typeof args.atypical_id === 'string' ? args.atypical_id.trim() : '';

  if (!nameRaw && !npiRaw && !atypicalIdRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, and/or atypical_id. An NPI or atypical-ID match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  const npiMatches = npiRaw && isTenDigitNpi(npiRaw) ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];
  const atypicalMatches = atypicalIdRaw ? ROWS.filter((r) => r.atypical_id && r.atypical_id.trim() === atypicalIdRaw) : [];

  const identitySeen = new Set<NcDhbRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of atypicalMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'atypical_id_match'));
  }

  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    const ownershipOnly: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue;
      const entityNorm = r.excluded_entity ? normalize(r.excluded_entity) : '';
      const ownershipNorm = r.ownership ? normalize(r.ownership) : '';
      if (entityNorm && qNorm === entityNorm) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (qTokens.length > 0 && entityNorm && qTokens.every((t) => entityNorm.includes(t))) {
        partial.push(shape(r, 'name_candidate_partial'));
      } else if (ownershipNorm && (qNorm === ownershipNorm || (qTokens.length > 0 && qTokens.every((t) => ownershipNorm.includes(t))))) {
        ownershipOnly.push(shape(r, 'ownership_only_match'));
      }
    }
    nameResults = [...exact, ...partial, ...ownershipOnly];
  }

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found in the NC Medicaid State Excluded Providers List for that provider.',
      screened: { name: nameRaw || null, npi: npiRaw || null, atypical_id: atypicalIdRaw || null },
      caveat: `This checks the NC Medicaid State Excluded Providers List only. It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, or any other state's Medicaid exclusion list (see ny-omig-exclusions, ca-medical-exclusions, tx-medical-exclusions, fl-medical-exclusions, pa-medical-exclusions, ga-medical-exclusions, oh-medical-exclusions, nj-medical-exclusions). ${SNAPSHOT_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  return {
    found: true,
    screened: { name: nameRaw || null, npi: npiRaw || null, atypical_id: atypicalIdRaw || null },
    count: matches.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    snapshot_caveat: SNAPSHOT_CAVEAT,
    ownership_caveat: OWNERSHIP_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage(args: Record<string, unknown>) {
  const withNpi = ROWS.filter((r) => r.npi).length;
  const withAtypicalId = ROWS.filter((r) => r.atypical_id).length;
  const dates = ROWS.map((r) => r.effective_date).filter((d): d is string => Boolean(d)).sort();
  const reasons = new Set(ROWS.map((r) => r.reason_for_exclusion).filter(Boolean));

  // fleet #3170: count-by-date-range mode, same as the eight precedent
  // state packs. Counted field is effective_date — NC Medicaid's own
  // EFFECTIVE DATE column.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const count = ROWS.filter((r) => inRange(r.effective_date, range)).length;
    return {
      found: true,
      mode: 'date_range_count',
      count,
      date_field_counted: 'effective_date — NC Medicaid\'s own EFFECTIVE DATE column.',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: 'the whole list, not a page',
      total_rows: TOTAL_ROWS,
      oldest_effective_date: dates[0] ?? null,
      newest_effective_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      snapshot_caveat: SNAPSHOT_CAVEAT,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
    };
  }

  return {
    found: true,
    total_rows: TOTAL_ROWS,
    currently_excluded: TOTAL_ROWS,
    with_npi: withNpi,
    with_atypical_id: withAtypicalId,
    distinct_reasons: [...reasons].sort(),
    oldest_effective_date: dates[0] ?? null,
    newest_effective_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    snapshot_caveat: SNAPSHOT_CAVEAT,
    ownership_caveat: OWNERSHIP_CAVEAT,
    listing_url: LISTING_URL,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'nc_medical_check_exclusion',
    description:
      'Is this healthcare provider excluded from the North Carolina Medicaid program? Screens a person or business name, an NPI, and/or an atypical (non-NPI) Medicaid provider ID against NC Medicaid\'s (Division of Health Benefits, Office of Compliance and Program Integrity) State Excluded Providers List — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for North Carolina specifically, and the sibling of ny_omig_check_exclusion (New York), ca_medical_check_exclusion (California), tx_medical_check_exclusion (Texas), fl_medical_check_exclusion (Florida), pa_medical_check_exclusion (Pennsylvania), ga_medical_check_exclusion (Georgia), oh_medical_check_exclusion (Ohio) and nj_medical_check_exclusion (New Jersey). Answers "is this provider excluded from North Carolina Medicaid" or pre-payment/credentialing screening for an NC Medicaid provider. '
      + 'An NPI or atypical-ID match is an IDENTIFICATION (both are exact, provider-specific identifiers); a name match against the EXCLUDED ENTITY field — even an exact one — is a CANDIDATE lead only, since this list carries no date of birth to tell same-named providers apart. A name that matches only the OWNERSHIP field (not the excluded entity) comes back as ownership_only_match with excluded:false — NC Medicaid\'s own note says an owner/principal name is NOT itself excluded unless separately listed. This dataset is a CURRENT SNAPSHOT (no history of lifted exclusions), so every match is currently_excluded:true. Pass npi or atypical_id to turn a name lead into an identification. Sourced from the NC Medicaid State Excluded Providers List, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "Jane Doe" or "Acme Home Health LLC". Matched against the excluded entity name first, then the ownership field.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        atypical_id: { type: 'string', description: 'NC Medicaid\'s non-NPI "atypical" provider ID, if known (used for some providers instead of an NPI). A match is an identification.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'nc_medical_exclusion_coverage',
    description:
      'What the NC Medicaid State Excluded Providers List covers and how current it is: total rows, how many carry an NPI vs. an atypical (non-NPI) ID, the distinct exclusion reasons published (FEDERAL, STATE, OIG, and combinations), and the oldest/newest exclusion effective dates. Notes that this is a CURRENT SNAPSHOT (not an ever-excluded history) — a reinstated provider simply disappears from the next monthly file. '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT how many exclusions have an effective date in that year or range, counted over the whole list, not a page — answers "how many NC Medicaid exclusions took effect in 2025". The response names the date field counted (effective_date — NC Medicaid\'s own EFFECTIVE DATE column). Sourced from the NC Medicaid State Excluded Providers List, keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'nc_medical_check_exclusion':
      return checkExclusion(args);
    case 'nc_medical_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
