# can-i-apply

Which remote job postings can a person resident in a given country actually hold?

Job boards express location eligibility as free text, and the text is wildly inconsistent. A real
Canonical posting lists its eligibility as `Home based - EMEA`. A human knows that includes Kenya.
No regex does, because the string contains neither a country name nor a country code. This project
turns strings like that into a verified set of ISO 3166-1 alpha-2 country codes, stores the result
relationally in PostgreSQL, and answers one question well: which postings is a resident of country
X eligible for?

The interesting part is not the model call. It is the gate in front of it. The model proposes
country codes; a deterministic verifier checks every single one against a committed ISO 3166-1
register before anything is written. A code the model invents is rejected, recorded and surfaced,
never persisted.

## Stack

Node.js 20 or newer, TypeScript in strict mode, PostgreSQL, TypeORM with real migrations,
Claude via the Anthropic SDK, Express, Vitest.

## The data is real

Nothing in this repository is a made up job posting.

| Source | Endpoint | Status when captured |
| --- | --- | --- |
| Canonical, via Greenhouse | `https://boards-api.greenhouse.io/v1/boards/canonical/jobs` | live, HTTP 200, 310 postings |
| Deel | `https://www.deel.com/careers/open-roles` | live, HTTP 200, 265 postings |

Both responded. Deel does not publish a JSON API; its board is embedded as escaped JSON inside the
React streaming payload in the page HTML, so `src/ingest/deel.ts` unescapes it and reads the
objects with a string aware balanced brace scan rather than a regex, because the objects nest.

`tests/fixtures/` holds a sample of each, captured from those endpoints: 23 Canonical postings
chosen to cover every distinct location string, and 60 Deel postings. `npm run fixtures:refresh`
re-captures them.

One deliberate alteration: this repository forbids the characters U+2012 to U+2015, and one real
Deel job title contained an en dash, so captured board text has those characters replaced with a
plain hyphen on write. It affects one title. Location strings, the only field this project reasons
about, are untouched, and the live ingest path does no such replacement.

## Schema

```
company ---< posting >--- posting_location ---< location
                                                  ^
                                                  |
                               seeded only from the committed ISO register

posting ---< rejected_code
```

Five tables, in `src/entities/`, created by migrations in `src/migrations/`. `synchronize` is off.

`posting_location` is a real many to many join, not a text column or an array, and that is the
whole point. The question being asked is the reverse of the one the raw data answers. The posting
says "EMEA"; the query asks "show me everything Kenya can hold". A denormalised
`eligible_countries text[]` column would make that query a scan and an unnest over every row, would
make `GROUP BY country` awkward, and would give the database no way to reject a country that does
not exist.

Normalisation decisions worth naming:

- `location` is seeded from `src/iso/countries.ts`, the committed register of exactly 249 assigned
  alpha-2 codes, and from nothing else. `posting_location.location_id` is a foreign key with
  `ON DELETE RESTRICT`. So the database enforces the same rule as the verification gate: a country
  that is not in ISO 3166-1 cannot be referenced, even if the application layer were bypassed.
- The join table is a first class entity carrying `derivation` (`exact_match` or `model_verified`)
  and `confidence`. Provenance lives on the edge, because the edge is the thing that was inferred.
  An exact match has a null confidence rather than a fake `1.0`.
- `rejected_code` is a table, not a log line. If the model's failure rate is only visible in stdout
  it is not measurable. `npm run cli rejections` and `GET /rejections` read it.
- `posting` is unique on `(source, external_id)`, so re-ingesting a board is idempotent.

## The index and the measured numbers

The hot path is `ELIGIBILITY_SQL` in `src/query/eligibility.ts`. It is written as raw SQL rather
than through the query builder specifically so that the statement measured below is character for
character the statement that runs.

The primary key of `posting_location` is `(posting_id, location_id)`. Its btree leads on
`posting_id`, which serves "which countries does this posting list". The eligibility query asks the
opposite: "which postings list this country". There is no index with `location_id` as a leading
column, so that side degenerates to a sequential scan of the whole join table. Hence:

```sql
CREATE INDEX idx_posting_location_eligibility
  ON posting_location (location_id, posting_id);
```

Leading on `location_id` for the lookup, with `posting_id` second so the index also covers the join
back to `posting`.

### Measured, not estimated

Reproduce with `npm run bench:index`, which drops the index, measures, recreates it, measures
again, and prints the full plans. Measured on PostgreSQL 18.4, best execution time over five runs,
`EXPLAIN (ANALYZE, BUFFERS)`, country `KE`.

**At the real data size (83 postings, 2074 eligibility edges):**

| | Execution time |
| --- | --- |
| Without the index | 2.528 ms |
| With the index | 2.367 ms |

Essentially identical, and the honest reading is that at this size the index does not matter. The
whole table is a handful of pages, so Postgres reads it either way. Quoting a speedup here would be
dishonest.

**At 101,674 eligibility edges across 99,683 postings**, grown with
`npm run bench:index -- --scale 400`:

| | Execution time | Plan node for `posting_location` |
| --- | --- | --- |
| Without the index | 29.941 ms | `Seq Scan on posting_location (cost=0.00..2498.74 rows=101674) (actual time=0.026..12.467 rows=101674.00 loops=1)` |
| With the index | 4.517 ms | `Bitmap Index Scan on idx_posting_location_eligibility (cost=0.00..11.48 rows=408) (actual time=0.101..0.101 rows=412.00 loops=1)` |

6.6x faster, and the join goes from reading all 101,674 rows to touching 412. A second run of the
same benchmark gave 29.405 ms against 5.066 ms, 5.8x, so the effect is stable and the variance is a
few hundred microseconds.

The synthetic rows used for the scaled measurement are generated from the real ISO register under
the company slug `synthetic-benchmark` and are deleted at the end of the run. The small table
numbers above are the unaltered real data.

## The verification gate

`src/normalise/verifier.ts`. It is a pure function. It has no dependency on the model provider, the
network or the database, which is what makes it impossible for a model to talk its way past.

Normalisation runs in two passes, and both of them funnel through the same gate, so there is
exactly one place in the codebase where a country code becomes legitimate:

1. **Deterministic pass.** If every comma separated segment of the location text resolves to a
   country by exact name or known alias, the model is never called. This is all or nothing on
   purpose: `Germany, EMEA` does not partially resolve, because silently dropping EMEA would be
   worse than asking the model.
2. **Model pass.** Claude receives the raw string and returns proposed codes with confidences.

The gate then accepts a proposal only if it is two ASCII letters, is present in the committed ISO
register, carries a confidence in `[0, 1]`, and has not already been seen. Rejection reasons are
`malformed`, `not_iso_3166_1`, `confidence_out_of_range` and `duplicate`. Case and surrounding
whitespace are forgiven, because `ke ` is `KE` badly typed. Nothing else is.

### A worked rejection, from real data

This is a verbatim `all_locations` string from a live Deel posting:

```
Czech Republic, Poland, Turkey, United Kingdom, Albania, Serbia, Romania, Moldova, Hungary,
Spain, Malta, Portugal, Greece, United Arab Emirates, North Macedonia, Bosnia & Herzegovina,
Egypt, Estonia, Croatia, Bulgaria, Cyprus, Armenia, Georgia, France, Israel, Italy, Kosovo,
Latvia, Lithuania, Slovenia
```

Thirty place names. Twenty nine of them are ISO 3166-1 countries. **Kosovo is not.** It has no
assigned alpha-2 code; `XK` is in widespread use but is user assigned, not part of the standard.
A model asked to produce country codes will confidently return `XK`, and in this corpus it does so
for six postings.

```
$ npm run cli rejections

6 rejected codes

XK  not_iso_3166_1  (model: replay)
  from: Czech Republic, Poland, Turkey, United Kingdom, Albania, Serbia, Romania, Moldova...
```

The posting ends up with 29 eligibility edges, not 30. `XK` is written to `rejected_code` with the
raw text and the model name, and no row is written to `posting_location`. The other 29 codes in the
same response are unaffected: a rejection does not poison the batch. This is the same discipline as
the citation grounding scorer in
[groundwork](https://github.com/sherrykisilu/groundwork), applied to a different stack: the model
is allowed to propose, never to assert.

Also rejected by construction: `UK` (the assigned code is `GB`), `EU`, and the exceptionally
reserved and withdrawn codes. They are absent from the register precisely because they are the ones
a model reaches for when it is guessing.

## Offline tests

The suite runs with no `ANTHROPIC_API_KEY` and no network. `src/normalise/provider.ts` defines one
interface with two implementations: `AnthropicProvider` for live calls, and `ReplayProvider`, which
serves recorded responses from `tests/fixtures/model-responses.json` keyed by the raw location
string. `createProvider` picks the live one only if a key is present. CI sets no secrets, so a
green build proves the offline path works.

48 tests across 5 files. The gate, the parsers and the normalisation pipeline need no database; the
SQL tests do. `REQUIRE_DB_TESTS=1`, which CI sets, turns a missing `TEST_DATABASE_URL` into a
failure rather than a skip, so a green build can never mean the database tests quietly did not run.

**Be aware:** the recordings in `tests/fixtures/model-responses.json` were authored against the
documented response contract rather than captured from a live API, because no Anthropic key was
available on the machine this was built on. The fixture says so in its own `note` field. They are
shaped exactly as the SDK returns and they exercise every path including the `XK` rejection, but
they are not live captures. Re-record them with:

```bash
ANTHROPIC_API_KEY=... npm run fixtures:refresh
```

## Running it from scratch

Requires Node.js 20 or newer and Docker.

```bash
git clone https://github.com/sherrykisilu/can-i-apply.git
cd can-i-apply
npm install
cp .env.example .env

docker compose up -d           # PostgreSQL 16 on localhost:5432
npm run migration:run

npm run cli -- ingest --fixtures   # or drop --fixtures to hit the live boards
npm run cli -- normalise           # replay provider unless ANTHROPIC_API_KEY is set
npm run cli -- eligible --country KE
```

Expected output of the last command:

```
Accountant
  Canonical  [model_verified 0.92]
  says: Home based - EMEA
  https://job-boards.greenhouse.io/canonical/jobs/5569916
```

Other commands:

```bash
npm run cli -- rejections              # what the gate refused
npm run cli -- explain --country KE    # EXPLAIN ANALYZE the live statement
npm run bench:index -- --scale 400     # reproduce the numbers above
npm run api                            # GET /health, /eligible/:code, /rejections
```

Checks:

```bash
npm run lint
npm run typecheck
npm test
npm run scan:dashes
```

`npm test` needs `TEST_DATABASE_URL` pointing at a second database. `docker compose` creates
`can_i_apply_test` for this via `docker/init-test-db.sql`.

## Limitations

Read this part before trusting the output.

- **This tool reports what a posting says. That is not the same as being eligible to work.** A
  posting listing a country does not mean the employer can legally engage someone there. Right to
  work, visa status, tax residency, whether the company has an entity or an employer of record in
  that country, and contractor versus employee classification are all out of scope and all
  decisive. Nothing here is immigration or employment law advice.
- **Region expansion is a judgement call.** Whether EMEA includes Kenya is the model's reading of a
  recruiter's shorthand, not a published definition. The gate guarantees every code is a real
  country. It cannot guarantee the country belongs in the set.
- The gate validates that a code exists. It does not validate that the code is correct. A model
  that returns `FR` for an Italy only posting passes the gate, because `FR` is a real country. The
  gate is a floor, not a ceiling.
- Confidence values come from the model and are not calibrated. Treat them as ordering, not
  probability.
- Two boards, one of which is scraped from HTML. Deel's embedded payload has no stability
  guarantee and will break when they change their frontend.
- The model recordings are authored rather than live captured, as stated above.
- The scaled performance numbers use synthetic rows. The schema and the statement are real, the
  volume is manufactured.
- `--fixtures` reads 83 committed postings. Live ingestion pulls roughly 575 and costs real model
  calls.

## Licence

MIT.
