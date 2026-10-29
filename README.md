# @pipeworx/nc-medical-exclusions

Screens a provider or business name, an NPI, or a non-NPI "atypical"
Medicaid provider ID against North Carolina's Medicaid provider exclusion
list — the state-level counterpart to the federal HHS OIG LEIE for North
Carolina specifically, and the sibling of ny-omig-exclusions,
ca-medical-exclusions, tx-medical-exclusions, fl-medical-exclusions,
pa-medical-exclusions, ga-medical-exclusions, oh-medical-exclusions and
nj-medical-exclusions.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `nc_medical_check_exclusion(name?, npi?, atypical_id?, limit?)` — screens
  a provider or business against the list. An NPI or atypical-ID match is
  an IDENTIFICATION; a name match against the EXCLUDED ENTITY field is a
  CANDIDATE lead only. A name that matches only the OWNERSHIP field of a
  row (an owner/principal listed for context, per NC Medicaid's own
  published note) comes back `match_type: "ownership_only_match"` with
  `excluded:false` — never conflated with an exclusion.
- `nc_medical_exclusion_coverage(year?, start_date?, end_date?)` — with no
  arguments, reports total rows, how many carry an NPI vs. an atypical ID,
  the distinct exclusion reasons, and the oldest/newest effective dates.
  With `year` or a date range, counts how many exclusions took effect in
  that window (counted by `effective_date`, over the whole list, not a
  page).

## Auth

Keyless.

## Data sources

- NC Medicaid, Division of Health Benefits, Office of Compliance and
  Program Integrity — State Excluded Providers List. Service providers
  terminated for cause from North Carolina's Medicaid and other Health
  Programs. No login, no CAPTCHA.

## Notes

- **This is a CURRENT SNAPSHOT, not an ever-excluded history** — unlike
  the TX/PA/NJ precedent packs. NC Medicaid publishes no end/reinstatement
  date column; a reinstated provider simply disappears from the next
  monthly file (same construction as ga-medical-exclusions). Every row
  this pack serves is therefore `currently_excluded:true`.
- **No home address is served.** This source carries no street address at
  all for any row — CITY/STATE/ZIP is the provider's registered location,
  served at the same coarse grain ga-medical-exclusions serves its STATE
  field, never a street-level address.
- **OWNERSHIP is not an exclusion.** NC Medicaid's own published caveat:
  names in the OWNERSHIP column are not excluded unless separately listed
  under EXCLUDED ENTITY. This pack keeps that distinction live in its
  match types rather than treating an ownership hit as a finding.
- **The identifier is not always an NPI.** NC Medicaid's own column header
  is "NPI/ATYPICAL ID (EXCLUDED)" — most rows carry a well-formed 10-digit
  NPI, but a minority carry an 8-digit non-NPI "atypical" Medicaid provider
  ID instead. `npi` and `atypical_id` are kept as separate fields.
- **Effective dates are mixed-type in the source file itself** — most
  rows store the date as an Excel date serial, a handful as a literal
  "MM/DD/YYYY" string. Both are decoded to the same ISO date.
- Refreshed by `scripts/bake-index.mjs`, which re-fetches the published
  file (NC Medicaid's download link is stable — no listing page to
  re-resolve) and rebuilds `src/nc-dhb-index-data.ts`; re-run periodically
  and recommit. `data_as_of` on every response says how stale the baked
  copy is.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nc-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/nc-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nc-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nc_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"HOSFORD"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nc_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-nc-medical-exclusions` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/nc-medical-exclusions/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "nc-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nc-medical-exclusions"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nc Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
