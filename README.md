# Kuberaxis

**Where wealth meets intelligence.**

Inspired by Kubera, the deity of wealth and prosperity, and the concept of an *axis* — a central point around which everything revolves — **Kuberaxis** represents a smarter, more connected approach to managing money.

Kuberaxis is built around a simple idea: financial complexity shouldn't stand in the way of financial clarity. By bringing powerful tools, actionable insights, and intelligent workflows together, Kuberaxis aims to make financial data more accessible, decisions more informed, and wealth management more intuitive.

### Our Philosophy

- **Clarity over complexity** — Turn complicated financial information into meaningful insights.
- **Intelligence by design** — Build tools that help people understand their finances and make better decisions.
- **Control through visibility** — Put the information needed to make confident financial decisions in one place.
- **Built for growth** — Create a foundation that can evolve alongside users, their goals, and their ambitions.

### The Name

*Kubera* symbolizes wealth, prosperity, and abundance. *Axis* represents alignment, structure, and a central point of control.

Together, **Kuberaxis** embodies the idea of a central intelligence for financial growth — a place where data, strategy, and opportunity converge.

---

*Build intelligently. Grow intentionally.*

## Development

Requires Node 22+ and Docker.

```sh
npm install
npm run db:up   # Postgres 18 via docker compose (port 5432; override with POSTGRES_PORT)
npm run dev     # API on :3001 (applies migrations on start) + web on http://localhost:5173
npm test        # parser + API tests (import tests need the DB)
```

| Path | What |
| --- | --- |
| `packages/parser` | U.S. Bank statement PDF parser (`npm run parse:usbank -w @kuberaxis/parser -- <file.pdf>`) |
| `test-data` | `usbank-sample-statement.pdf`, a fictional statement (regenerate with `npm run sample:usbank -w @kuberaxis/parser`). Put real statements in `test-data/manual/` (gitignored) and the parser tests will check them too. |
| `apps/api` | Fastify + Postgres API: `POST /api/imports` (multipart PDF), `GET /api/transactions` |
| `apps/web` | React + Vite + TanStack Table UI |

### Releases

Every push to `main` runs `.github/workflows/release.yml`: it tests the code, picks the next semantic version from
the commit messages since the last `vX.Y.Z` tag, packages the Helm chart with `version` and `appVersion` set to it,
and creates a tagged GitHub Release with the chart attached.

| Commits since the last release include | Bump |
| --- | --- |
| `feat!: ...`, `fix(api)!: ...`, or a `BREAKING CHANGE:` footer | major |
| `feat: ...` / `feat(scope): ...` | minor |
| anything else | patch |

The first release is `v0.1.0`.

### Import de-duplication

Each transaction is fingerprinted (date, amount, type, description, details, ref number, card) and numbered by
occurrence within its statement, so two genuinely identical charges on the same day are both kept. A unique
`(account, fingerprint, occurrence)` constraint makes re-importing a statement, or an overlapping one, skip
rows that are already stored.
