# PharmaSense Production Readiness Audit

**Scope:** Next.js 16 App Router, Server Actions, custom database-backed sessions, Drizzle ORM, Neon PostgreSQL.

**Audit result:** **Conditionally ready for staging; not ready for production POS traffic** until the high-priority fixes below are addressed.

## Validation performed

- `corepack pnpm exec tsc --noEmit` — **passed**.
- `corepack pnpm run build` with the project environment loaded — **passed**.
- Live Neon index inspection — completed against project `sparkling-rice-31037442`.
- Audited `/app/actions/pharmacy-actions.ts`, `/app/actions/auth-actions.ts`, `/lib/auth.ts`, `/db/schema.ts`, `/db/index.ts`, and `next.config.mjs`.

Note: running the build without loading the project environment fails because `/db/index.ts` intentionally requires `DATABASE_URL` at module initialization. With the configured project environment loaded, the build completes successfully.

## Executive summary

The core multi-tenant boundary is present and consistently applied in the pharmacy Server Actions: each action calls `requireSession()`, derives `tenantId` from the database-backed session, and includes tenant predicates on tenant-owned reads and writes. The session lookup also verifies that the session tenant and role still match the current user.

The main production blockers are POS concurrency and price integrity, incomplete tenant indexes, disabled build-time type enforcement, and missing operational hardening such as rate limiting, session cleanup, and security headers.

## 1. Security and multi-tenancy

### Passing controls

- `createMedicineAction`, `createSaleAction`, `updateInventoryAction`, `createExpenseAction`, and `createPurchaseOrderAction` do not accept a tenant ID from the caller.
- Every pharmacy action derives `tenantId` from `requireSession()`.
- Medicine, cashier, inventory, and purchase item lookups include `tenantId` predicates.
- Cashier authorization prevents a cashier from recording a sale for another cashier.
- Role checks prevent cashiers from creating medicines, adjusting inventory, creating expenses, or creating purchase orders.
- Session lookup rejects mismatched session/user tenant IDs or roles.
- Foreign keys use tenant ownership on core records with cascading tenant deletion and restrictive medicine deletion where appropriate.
- Passwords are salted and hashed with Node `scrypt`; no plaintext password storage was found.

### High-priority findings

#### P0 — POS price tampering remains possible

`createSaleAction` accepts `unitPrice` from the client and uses it to calculate invoice totals and sale-item subtotals. A malicious client can submit a price lower than the medicine's stored `sellingPrice`.

**Fix:** accept medicine IDs and quantities only; load current prices from `medicines` inside the transaction and calculate all line totals server-side. Do not trust `totalAmount`, `unitPrice`, or `subtotal` from the client.

#### P0 — Concurrent sales can oversell inventory

The sale flow selects stock, checks it, then issues a separate update. Two concurrent transactions can both observe the same stock and both succeed.

**Fix:** atomically decrement with a predicate such as `WHERE id = ? AND tenant_id = ? AND stock >= ?`, then require exactly one updated row. Aggregate duplicate medicine IDs before the transaction so one invoice cannot bypass the stock check through repeated lines.

#### P1 — Tenant consistency is application-enforced, not database-enforced

`tenant_id` exists on `sale_items` and `purchase_order_items`, but their foreign keys do not enforce that the referenced invoice/order and medicine belong to the same tenant. The Server Actions do enforce this for their normal path, but a future query or compromised internal caller could create cross-tenant relationships.

**Fix:** add composite unique keys and composite foreign keys, for example `(tenant_id, id)` on parent tables and matching `(tenant_id, invoice_id)` / `(tenant_id, medicine_id)` references.

#### P1 — Authentication lacks abuse controls

There is no rate limiting, account lockout, password reset flow, email verification, session revocation UI, or cleanup job for expired sessions. `scryptSync` is intentionally CPU-heavy and can be abused through repeated login attempts without a request limiter.

**Fix:** add an edge/server rate limiter, login attempt monitoring, session expiry cleanup, and a password recovery flow before public launch.

#### P1 — Session lifecycle hardening is incomplete

Login creates a new session but does not revoke older sessions. Expired sessions are only ignored during lookup and are not deleted. There is no explicit session version or global logout mechanism.

**Fix:** add session revocation metadata and periodic cleanup; optionally revoke all existing sessions on password change or account disablement.

## 2. Type and build integrity

- Strict TypeScript check passed with no reported implicit `any`, missing imports, or type diagnostics.
- Production build passed after loading the project environment.
- `next.config.mjs` sets `typescript.ignoreBuildErrors: true`. This is a production risk because future deployments can build while TypeScript errors exist even though the standalone audit command currently passes.

**Recommended fix:** remove `ignoreBuildErrors` and make the build fail on type errors.

## 3. Schema, relation, and query alignment

### Correctly aligned

- Actions use the same tenant, medicine, invoice, inventory movement, expense, purchase order, and session tables defined in `/db/schema.ts`.
- Foreign-key delete behavior matches the intended lifecycle for tenants, sessions, invoices, medicines, and purchase orders.
- Auth actions create a tenant and admin user transactionally.
- Sale creation inserts invoice, sale items, and inventory movements inside one transaction.
- Inventory adjustment updates stock and records the delta movement in one transaction.

### Schema concerns

- Relations do not include explicit session, purchase-order, or purchase-order-item relation objects. This does not break the current direct queries but makes relational eager loading and future schema validation less complete.
- Email uniqueness is tenant-scoped in the database, while registration checks email globally. This is a product-policy mismatch: either make email globally unique intentionally or scope the registration rule to the tenant model.
- No database-level `CHECK` constraints enforce non-negative stock, positive quantities, non-negative amounts, or valid discounts. Server validation exists, but database constraints provide defense in depth.

## 4. Index and performance audit

### Current live indexes

Present:

- `users (tenant_id, email)` unique index.
- `medicines (tenant_id, sku)` unique index.
- `sales_invoices (tenant_id, invoice_number)` unique index.
- Primary keys on all audited tables.

Missing for common tenant-scoped access patterns:

- `inventory_movements (tenant_id, medicine_id, created_at)`.
- `inventory_movements (tenant_id, created_at)` for tenant activity reports.
- `expenses (tenant_id, date)`.
- `sale_items (tenant_id, invoice_id)`.
- `sale_items (tenant_id, medicine_id)`.
- `purchase_orders (tenant_id, created_at)`.
- `purchase_order_items (tenant_id, purchase_order_id)`.
- `sessions (tenant_id, expires_at)` and optionally `sessions (user_id)`.

The current schema is acceptable for a small staging dataset, but reporting and inventory history will degrade as tenant volume grows.

### N+1 patterns

- Sale creation performs a medicine select plus insert, update, and movement insert for each line item.
- Purchase-order creation performs a medicine select and item insert for each line item.

These are transactional, which preserves consistency, but they are still N+1 patterns. Preload all medicine rows with one `IN` query, validate them in memory, then batch inserts and use controlled updates.

## 5. Error handling and edge cases

- Server Actions throw plain `Error` values. This is acceptable for internal enforcement but should be converted into structured, user-safe action results for production UI handling.
- Login returns a generic invalid-credentials error, which is good. Registration also avoids exposing the existing-account detail.
- `createSaleAction` validates `totalAmount` but ultimately calculates a total from client-provided line prices. This is the central financial-integrity issue.
- Duplicate medicine IDs in one sale can produce incorrect stock semantics unless lines are aggregated.
- Invoice number uniqueness is tenant-scoped and protected by the database, but duplicate-key errors are not translated into a friendly retry-safe result.
- There is no idempotency key for POS checkout. A network retry can create duplicate invoices if the client retries after a successful commit but before receiving the response.
- Date parsing uses `new Date(...)` without explicit timezone/format validation. Date-only pharmacy fields should be validated as ISO dates to avoid timezone shifts.

## 6. Production configuration checklist

### Present / confirmed

- `DATABASE_URL` and Neon PostgreSQL environment variables are available to the project.
- `db/index.ts` uses a shared `pg` pool and Drizzle schema.
- Auth session cookie is HttpOnly, path-scoped, and secure in production.
- Protected application routes redirect unauthenticated users to `/login`.

### Missing or recommended

- Remove `typescript.ignoreBuildErrors`.
- Add security response headers in `next.config.mjs`: `X-Content-Type-Options`, strict referrer policy, HSTS in production, an appropriate permissions policy, and a report-only CSP before tightening it.
- Add rate limiting for login, registration, and POS mutation endpoints.
- Add structured server-side logging and alerting for authorization failures, stock conflicts, duplicate invoices, and database errors.
- Add a session cleanup job and a retention policy for inventory/audit data.
- Add an explicit production migration mechanism and migration history table; the current live schema was applied through ad-hoc SQL.
- Add database backups/restore drills and connection-pool monitoring.

## Recommended quick-fix order

1. Recompute prices and totals from database medicine rows; never trust client prices.
2. Make stock decrement atomic and add POS idempotency keys.
3. Add missing tenant/date indexes.
4. Remove `ignoreBuildErrors` and add production security headers.
5. Add rate limiting, session cleanup/revocation, and structured error handling.
6. Add composite tenant foreign keys and database `CHECK` constraints.

## Final status

**Overall:** Strong foundation with the intended tenant boundary in the normal Server Action path, but **not production-ready for live pharmacy checkout yet**. The two blockers that must be resolved before real transactions are accepted are server-side price calculation and atomic inventory decrementing. After those, address indexing, build enforcement, abuse controls, and operational observability before general release.
