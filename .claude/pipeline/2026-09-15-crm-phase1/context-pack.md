# Context Pack: Absorbing Frappe CRM into RouteFlow

Research-only fact pack for a Fable planner. No recommendations. Every fact is cited;
anything not directly verified is marked **UNVERIFIED**.

Sources: GitHub pages fetched via WebFetch on 2026-09-15 (`frappe/crm`, `develop` branch) for
Part A; `C:\ClaudeCode\routeflow\.claude\code-map\*` (read directly) and
`git -C C:\ClaudeCode\routeflow show origin/master:<path>` for Part B. No files were cloned,
downloaded, or executed.

---

## PART A — Frappe CRM (github.com/frappe/crm, `develop` branch)

### A1. License

- Source: `https://api.github.com/repos/frappe/crm` (GitHub repo metadata API, fetched
  2026-09-15).
- **License name: "GNU Affero General Public License v3.0"; SPDX id: `AGPL-3.0`.**
- Repo description returned by the same call: "Fully featured, open source CRM".
- I could not fetch the raw `license.txt`/`LICENSE` file text directly — a WebFetch to
  `https://raw.githubusercontent.com/frappe/crm/develop/license.txt` returned HTTP 404 (wrong
  filename guessed). The exact verbatim license header/text is therefore **UNVERIFIED** here;
  only the GitHub-reported SPDX identifier (AGPL-3.0) is confirmed. AGPL-3.0's defining trait
  (network use counts as distribution, triggering source-disclosure) is well-known but the
  pack does not quote the file text since it was not fetched.
- Separate license for docs/assets: **UNVERIFIED** — not checked (would require fetching the
  docs-site repo, e.g. `frappe/frappe_docs` or similar, which was out of scope given the tool
  budget).
- AGPL-3.0 is copyleft and its network clause is the single most consequential fact for any
  "absorb this code" plan — RouteFlow's own `CLAUDE.md` bans a second HTTP client and treats
  the repo as intending to go public briefly for CI (`Heavy files policy` section), so license
  compatibility between AGPL-3.0 source and a closed/public RouteFlow repo is a fact for the
  planner to weigh, not something resolved here.

### A2. Stack

Source: `https://raw.githubusercontent.com/frappe/crm/develop/README.md` (fetched 2026-09-15)
and `https://github.com/frappe/crm/tree/develop/frontend/src` (fetched 2026-09-15).

- **Backend**: Frappe Framework ("a full-stack web application framework"). Specific Frappe
  version pinned by `crm`'s `pyproject.toml`/`hooks.py` — **UNVERIFIED** (not fetched).
- **DB**: not stated on the README; Frappe Framework's standard default is MariaDB —
  **UNVERIFIED for this repo specifically** (inferred from general Frappe knowledge, not
  confirmed against this repo's files).
- **Frontend**: "Frappe UI, a Vue-based UI library". `frontend/src` tree (fetched via
  WebFetch) shows: `components/`, `composables/`, `data/`, `doctypes/`, `images/`, `pages/`,
  `stores/`, `utils/`, plus `App.vue`, `index.css`, `main.js`, `router.js`, `socket.js`,
  `translation.js`, `types.ts`. Presence of `composables/` + `stores/` + `types.ts` indicates
  **Vue 3 Composition API, likely Pinia for state, and partial TypeScript** — the Vue/Pinia
  major-version specifics are **UNVERIFIED** (inferred from directory shape, not a package.json
  read).
- **Realtime**: `frontend/src/socket.js` exists, implying a Socket.io (or similar) client;
  the exact library/version is **UNVERIFIED** (file not opened).
- **Deployment model**: README documents three paths — (1) **Frappe Cloud** (managed hosting,
  official), (2) **self-hosted via Docker or a traditional Frappe bench**, (3) **local
  development via Bench + a Vite dev server for the frontend**. This confirms Frappe CRM is
  **not a standalone deployable app** in the Node/Docker sense RouteFlow uses — it is a Frappe
  **app** that installs into a Frappe **bench** (Frappe's multi-app runtime/site manager) and
  cannot run without the Frappe Framework runtime underneath it. Live demo:
  `https://frappecrm-demo.frappe.cloud/#login`. Docs: `https://docs.frappe.io/crm`.
  Marketing page: `https://frappe.io/crm`.

### A3. Feature inventory

Sources: `https://docs.frappe.io/crm` introduction page (fetched 2026-09-15) and the
`crm/fcrm/doctype` tree (fetched 2026-09-15, see A4 for the full doctype list). The docs intro
page is a single overview page; it did **not** surface separate documentation on contacts,
organizations, mobile app, dashboards, form scripts, lost reasons, Gmail integration, REST API,
or webhooks as distinct docs sections — those rows below are inferred **only** from doctype
names in the repo tree (A4), which is a structural signal, not a confirmed behavioral spec; each
is marked accordingly.

| Feature | What it does (per docs.frappe.io/crm intro, or inferred from doctype names) | Key doctypes/entities | Confidence |
|---|---|---|---|
| Leads & Deals | "Track every prospect and opportunity in one place. Add notes, log calls, set tasks, and keep the full context of every relationship." Lead converts to Deal. | `crm_lead`, `crm_deal`, `crm_lead_status`, `crm_deal_status`, `crm_lead_source` | Confirmed (docs) |
| Contacts / Organizations | Deal/Lead link to a contact and an org. | `crm_contacts`, `crm_organization` | Doctype-inferred |
| Pipeline / Kanban & status flows | Kanban board layout for leads/deals; status-change tracking. | `crm_deal_status`, `crm_lead_status`, `crm_status_change_log` | Confirmed (docs: Kanban) + doctype |
| Views (list/kanban/saved/filters/sort/columns) | "List or Kanban board layouts with filtering, sorting, and customizable saved views." | `crm_view_settings` | Confirmed (docs) |
| Activities timeline / notes | Per-record activity/notes on leads and deals. | `fcrm_note` | Doctype-inferred (docs mentions "add notes") |
| Tasks | Task tracking against a lead/deal. | `crm_task` | Doctype-inferred (docs mentions "set tasks") |
| Email (in/out, templates, threads) | "Send and receive emails directly from records, utilize templates." Threading is a Frappe-core Communication feature, not a CRM-specific doctype. | Frappe core `Communication` doctype (not under `crm/fcrm/doctype`) + CRM's own template concept | Confirmed (docs) for send/receive/templates; thread storage mechanism UNVERIFIED |
| Calls (Twilio/Exotel) + call logs/recordings | Docs list Twilio and Exotel as integrations; doctype names confirm settings + log storage. | `crm_call_log`, `crm_twilio_settings`, `crm_exotel_settings`, `crm_telephony_agent`, `crm_telephony_phone` | Confirmed integration (docs) + doctype detail |
| WhatsApp | Docs list "WhatsApp" among integrations (via Meta). No dedicated `crm_whatsapp_*` doctype appeared in the fetched `fcrm/doctype` listing — messaging may ride on Frappe core's WhatsApp app/doctype instead. | None found under `fcrm/doctype`; **UNVERIFIED** which doctype backs it | Docs confirm the integration exists; storage mechanism UNVERIFIED |
| SLA / response-time tracking | "Enforce timely follow-ups through SLA management." | `crm_service_level_agreement`, `crm_service_level_priority`, `crm_rolling_response_time`, `crm_service_day`, `crm_holiday`, `crm_holiday_list` | Confirmed (docs) + doctype |
| Assignment rules / round-robin | "Route leads via assignment rules." | Likely rides on Frappe core's `Assignment Rule` doctype (not CRM-specific); `crm_sales_hierarchy` may factor into routing. | Confirmed concept (docs); exact doctype **UNVERIFIED** |
| Lost reasons | Standard CRM concept for a deal marked lost. | `crm_lost_reason` | Doctype-inferred |
| Custom fields / form scripts / field layouts | "Extend functionality by adding custom fields, statuses, and workflow-specific actions." | `crm_fields_layout`, `crm_form_script` | Confirmed (docs) + doctype |
| Permissions / roles | Frappe-core role/permission system applies; no CRM-specific doctype seen for this. | Frappe core (not listed under `fcrm/doctype`) | **UNVERIFIED** (not fetched) |
| Dashboards / analytics | A dashboard doctype exists. | `crm_dashboard` | Doctype-inferred |
| Import/export | Standard Frappe data-import tooling would apply; no CRM-specific import doctype seen. | **UNVERIFIED** | UNVERIFIED |
| Integrations (ERPNext, Gmail, etc.) | Docs explicitly list ERPNext and "third-party tools via APIs"; Gmail not named on the intro page. | `erpnext_crm_settings` confirms ERPNext; Gmail-specific doctype **UNVERIFIED** | Confirmed for ERPNext; Gmail unconfirmed |
| Mobile support | Not addressed by the fetched docs intro page or README. | **UNVERIFIED** | UNVERIFIED |
| Notifications | A notification doctype exists. | `crm_notification` | Doctype-inferred |
| Product/pricing sync | Product and product-sync-issue doctypes exist (likely ERPNext item sync). | `crm_product`, `crm_products`, `crm_product_sync_issue` | Doctype-inferred |
| Territory | Territory-based org structure. | `crm_territory`, `crm_industry` | Doctype-inferred |
| Invitations / global settings | Team invitations and tenant-wide CRM settings. | `crm_invitation`, `crm_global_settings`, `fcrm_settings` | Doctype-inferred |
| Dropdown/custom-list items | Configurable dropdown option sets. | `crm_dropdown_item` | Doctype-inferred |
| Communication status | Tracks per-communication delivery/read state. | `crm_communication_status` | Doctype-inferred |

### A4. Data model — doctypes

Source: `https://github.com/frappe/crm/tree/develop/crm/fcrm/doctype` (WebFetch, 2026-09-15).
Full list of doctype subdirectories returned (39 total — each is a Frappe "doctype", roughly
analogous to a Prisma model + its own generated admin UI):

`crm_call_log`, `crm_communication_status`, `crm_contacts`, `crm_dashboard`, `crm_deal`,
`crm_deal_status`, `crm_dropdown_item`, `crm_exotel_settings`, `crm_fields_layout`,
`crm_form_script`, `crm_global_settings`, `crm_holiday`, `crm_holiday_list`, `crm_industry`,
`crm_invitation`, `crm_lead`, `crm_lead_source`, `crm_lead_status`, `crm_lost_reason`,
`crm_notification`, `crm_organization`, `crm_product`, `crm_product_sync_issue`, `crm_products`,
`crm_rolling_response_time`, `crm_sales_hierarchy`, `crm_service_day`,
`crm_service_level_agreement`, `crm_service_level_priority`, `crm_status_change_log`,
`crm_task`, `crm_telephony_agent`, `crm_telephony_phone`, `crm_territory`,
`crm_twilio_settings`, `crm_view_settings`, `erpnext_crm_settings`, `fcrm_note`,
`fcrm_settings`.

I did not open individual doctype `.json` definitions (each doctype's field list lives in a
`<name>.json` inside its folder), so **exact field-level schemas for `crm_lead`, `crm_deal`,
etc. (e.g. what fields a Lead has, the Lead→Deal conversion mechanism's specific field
mapping, or how Deal links to Organization + Contact) are UNVERIFIED** — only the doctype
names/existence are confirmed from the directory listing. The docs intro page's line "Track
every prospect and opportunity in one place" plus the presence of both `crm_lead` and
`crm_deal` doctypes is the only evidence for a lead→deal relationship; the mechanics of that
conversion (automatic vs. manual, what carries over) were not verified.

### A5. API surface

**UNVERIFIED in detail.** Frappe Framework doctypes are automatically exposed via a generic
REST API (`/api/resource/<Doctype>`) and Python methods can be marked `@frappe.whitelist()` to
become callable RPC-style endpoints — this is standard Frappe Framework behavior, not something
specific to the CRM app's own code that was fetched and confirmed here. No CRM-specific
whitelisted-method list or webhook-doctype was opened (fetching `crm/api.py` or similar was
out of the tool budget for this pack). Frappe Framework separately ships a generic
`Webhook` doctype for outbound webhooks; whether Frappe CRM registers any CRM-specific webhook
triggers is **UNVERIFIED**.

---

## PART B — RouteFlow today

### B1. Code map areas consulted

- `.claude\code-map\INDEX.md` (root pointers, read directly).
- `.claude\code-map\api.md` → module index only (points to `api/feature-modules-{1..5}.md`,
  `api/misc.md`, `api/root-tooling-campaign-infrastructure.md`). A grep of the whole
  `.claude\code-map` directory for `CRM|GoHighLevel|GHL` returned **zero files** — the code map
  does not yet document the `crm` module at all (it exists on `origin/master` per B2 below; the
  map is stale for this area — flag for the planner, not fixed here per the research-only
  scope).
- `.claude\code-map\web.md`, `.claude\code-map\mobile.md`, `.claude\code-map\packages.md` — read
  in full (each is short; no area file mentions CRM/GHL/leads/prospects/pipeline by name
  either — confirmed via the same directory-wide grep).
- Because the code map is silent on CRM, all of Part B below for the `crm` module comes from
  direct `git show origin/master:<path>` reads, not the map.

### B2. Existing CRM-like capability inventory

| Capability | Where (module/model/screen) | Maturity | Source |
|---|---|---|---|
| GoHighLevel CRM connector (`crm` module) | `apps/api/src/crm/` — `crm.module.ts`, `crm.controller.ts` (`@Controller("crm/gohighlevel")`), `crm-connection.service.ts`, `gohighlevel/{gohighlevel.client,gohighlevel-poll.service,gohighlevel-handoff.service,gohighlevel-writeback.service}.ts` | Partial / pilot — merged, gated `dark` (allow + warn, no 403 yet) behind add-on key `crm_gohighlevel` | `git show origin/master:apps/api/src/crm/crm.module.ts`, `.../crm.controller.ts`, `.../billing/addon-gate-registry.ts` |
| CRM data model (`CrmConnection`, `CrmHandoff`) | `apps/api/prisma/schema/platform.prisma` | Full for what it does (one-way handoff sync from a GHL opportunity to a RouteFlow Customer, not a native CRM) | `git show origin/master:apps/api/prisma/schema/platform.prisma` |
| Poll/handoff/write-back pipeline | `apps/api/src/crm/gohighlevel/*` + a `@LeaderCron("*/3 * * * *", "crm-gohighlevel.poll")` runner in `crm.module.ts` | Full (cron-driven, per-tenant, isolates per-tenant failures) | same file |
| Customer entity (RouteFlow's core "account") | `apps/api/prisma/schema/sales.prisma` `model Customer` | Full — RouteFlow's central business-relationship model | `git show origin/master:apps/api/prisma/schema/sales.prisma` |
| Contact person (multiple contacts per customer) | `apps/api/prisma/schema/sales.prisma` `model ContactPerson` | Partial — flat contact record (name/email/phone/isPrimary), no activity/timeline of its own | same file |
| Customer notes | `Customer.notes` (single free-text field) **and** `model CustomerComment` (append-only, one row per note, tied to a `userId` author) | Partial — two separate note mechanisms, neither has a rich timeline/activity feed | same file |
| Customer tags | `model CustomerTag` + `model CustomerTagAssignment` | Full for simple tagging | same file |
| Messages / unified inbox | `apps/api/prisma/schema/platform.prisma` `model Message`, `model MessageThread`, `model MessageTemplate`, `model NotificationRule`, `model MessageOptOut`, `model MessagingSettings`, `model InboundTriage`; channels: `INTERNAL` (driver↔operator chat), `WHATSAPP`, `SMS`, `EMAIL`, `PORTAL` | Partial — schema explicitly says "Additive foundation… NOTHING here is wired to a provider yet (StubProvider + real adapters land in P6-3/P6-4)" per the schema comment | same file, `model Message` block comment |
| Notifications | `apps/api/src/notifications/` (directory exists on `origin/master`) | Maturity of contents **UNVERIFIED** (directory listing only, files not opened) | `git ls-tree origin/master -- apps/api/src/` |
| Email service | `apps/api/src/email/` (directory exists; imported by `CrmModule`) | Maturity of contents **UNVERIFIED** beyond being a real Nest module consumed elsewhere | `git ls-tree`, `crm.module.ts` imports `EmailModule`/`EmailService` |
| Sales agents + commissions | `apps/api/prisma/schema/sales.prisma` `model SalesAgent`, `SalesAgentRate`, `CustomerCommissionRate`, `AgentAssignment`, `CommissionAccrual`, `CommissionAdjustment`, `CommissionStatement`, `CommissionStatementLine`, `CommissionPayout` | Full data model; feature is flag-gated per code-map INDEX ("Sales agents & commissions (flag-gated)" → `src/sales-agents/`) | code-map `INDEX.md` row + `sales.prisma` |
| Buyer portal | `apps/api/src/buyer/` (directory exists on `origin/master`) | Maturity **UNVERIFIED** in detail; code-map `web.md`/`mobile.md` reference a buyer-facing surface but the buyer module's own contents were not opened | `git ls-tree`, `web.md`/`mobile.md` module tables |
| Customer tiers/pricing | `Customer.pricingTier` field + `model CustomerPrice`; commission side has `CustomerCommissionRate` | Full | `sales.prisma` |
| Audit log | `apps/api/prisma/schema/platform.prisma` `model AuditLog` (tenantId, userId, impersonatedBy, action, entityType, entityId, ip, meta Json, createdAt) | Full, generic across all modules | same file |
| Imports | `apps/api/src/import/` module; `ImportModule`/`ExternalRefService` imported by `CrmModule` (GHL handoff resolves/creates external refs); schema has `model ImportExternalRef`, `model MigrationJob`, `model MigrationStagingRecord`, `model ImportBatch`, `model ImportQueueItem` | Full generic import/migration infra, reused by the CRM handoff path | `crm.module.ts` imports; `platform.prisma` |

### B3. Prisma models relevant to a CRM

All models below live in the multi-file schema at `apps/api/prisma/schema/{sales,platform,tenancy,catalog}.prisma` (source: `git show origin/master:apps/api/prisma/schema/<file>.prisma`). Every model that carries a `tenantId` field is tenant-scoped (RouteFlow's universal invariant per `CLAUDE.md`); this was checked per-model below, not assumed.

| Model | File | Key fields (abridged) | tenantId? |
|---|---|---|---|
| `Customer` | sales.prisma | `businessName, contactName, phone, notes, email, mobile, customerType, displayName, salutation, firstName, lastName, taxId, creditLimit, currency, pricingTier, defaultPaymentTerms, defaultDepositPercent, smsConsent, waConsent, representsTenantId` | Yes (via relation chain / tenant-scoped ops; the model itself in this file doesn't show a bare `tenantId` scalar in the excerpt read — access is via `userId`/tenant-scoped services; **verify directly before relying on this** for a schema change) |
| `ContactPerson` | sales.prisma | `customerId, salutation, firstName, lastName, email, phone, mobile, isPrimary` | Yes — `tenantId String?` present |
| `CustomerComment` | sales.prisma | `customerId, userId, content, createdAt` | Yes — `tenantId String?` present |
| `CustomerTag` / `CustomerTagAssignment` | sales.prisma | tag name + assignment join | **UNVERIFIED** (not opened in detail) |
| `SalesAgent` | sales.prisma | `name, email, phone, notes, status (SalesAgentStatus), stopNewBusinessAt, userId` | Yes — `tenantId String?` present |
| `SalesAgentRate`, `CustomerCommissionRate`, `AgentAssignment`, `CommissionAccrual`, `CommissionAdjustment`, `CommissionStatement`, `CommissionStatementLine`, `CommissionPayout` | sales.prisma | commission math tables, related to `SalesAgent` | **UNVERIFIED** per-field (only model names confirmed via grep, not opened) |
| `Message` | platform.prisma | `runId, text, senderId, senderRole, threadId, channel (MessageChannel: INTERNAL/WHATSAPP/SMS/EMAIL/PORTAL)` | `tenantId String?` present |
| `MessageThread` | platform.prisma | `customerId, lastChannel, lastMessageAt, lastMessagePreview, unreadCount, status (ThreadStatus: OPEN/SNOOZED/CLOSED), snoozedUntil` | `tenantId String?` present |
| `MessageTemplate`, `NotificationRule`, `MessageOptOut`, `MessagingSettings`, `InboundTriage` | platform.prisma | not opened in field-level detail | **UNVERIFIED** per-field |
| `AuditLog` | platform.prisma | `tenantId?, userId?, impersonatedBy?, action, entityType, entityId?, ip?, meta Json?, createdAt` | `tenantId String?` present |
| `CrmConnection` | platform.prisma | `tenantId (unique), provider (default "gohighlevel"), locationId, secretCipher, tokenLast4, status (CrmConnectionStatus), enabled, dryRun, triggerMode (CrmTriggerMode), pipelineId, stageId, writeBackFields/Tag/Note, markWon, customFieldIds Json?, lastPollAt/lastSuccessAt/nextPollAt, lastError` | Yes — `tenantId` unique scalar |
| `CrmHandoff` | platform.prisma | `tenantId, provider, opportunityId, contactId, opportunityName?, contactName?, status (CrmHandoffStatus), customerId?, matchedBy?, reason?, payload Json?, attempts, nextAttemptAt?, noteWritten` | Yes — `tenantId` scalar |
| `TenantAddon` | platform.prisma | `tenantId, addonKey, sku?, quantity, priceSnapshot?, stripePriceId?, stripeItemId?, active` | Yes |
| `AddonSku` | platform.prisma | `planVersionId, sku, name, monthlyPrice, unit (AddonUnit), includedAtPlan?, meteredKey?, capacityPerUnit?, stackable, grantsFlags String[]` — this is the GLOBAL plan catalog, not tenant-scoped by design | No (deliberately global reference data per its own schema comment) |
| `ImportExternalRef`, `MigrationJob`, `MigrationStagingRecord`, `ImportBatch`, `ImportQueueItem` | platform.prisma | generic import/migration substrate reused by the GHL handoff path | **UNVERIFIED** per-field |

### B4. Entitlement model relevant to gating a CRM add-on

Source: `git show origin/master:apps/api/src/billing/addon-gate-registry.ts` and
`.../plan-flag.guard.ts`.

- **`@RequireAddon` gate**: every key must have a row in `ADDON_GATE_REGISTRY`
  (`apps/api/src/billing/addon-gate-registry.ts`). Each row has `state: "dark" | "enforced"`,
  `added` (date), `routes` (informational list of guarded endpoints), `grantPath` (where an
  operator grants the addon), `backfill` (the deploy-day decision text), optional `reviewBy`.
  `addon-gate-registry.spec.ts` fails `npm run verify` if a key is used with no row, a row has
  no live call site, or a `dark` row passes its `reviewBy` without a decision. Unregistered
  keys are treated as `enforced` at runtime (fail closed).
- **The existing `crm_gohighlevel` row** (already live on `origin/master`):
  `state: "dark"`, `added: "2026-09-11"`, guards 12 routes under `crm/gohighlevel/*`,
  `grantPath` is Platform Admin → Tenants → add-ons, `backfill` text: *"New feature
  2026-09-11: no tenant has a connection; gate stays dark through the pilot. Owner ruling
  2026-09-12: BILLABLE add-on at $9.99/month — a follow-up publishes the sellable `AddonSku`
  (FLAT, granting this key) in the next catalog version; flip to enforced only after that SKU
  exists, the pilot tenant holds it, and the blast-radius report is clean."*, `reviewBy:
  "2027-03-11"`. This is the exact precedent mechanism a new "full CRM" feature set would need
  to follow for every new gated route.
- **`@RequirePlanFlag` gate** (sibling, less mature): `apps/api/src/billing/plan-flag.guard.ts`
  has no registry yet. New plan flags ship inside a `DARK_PLAN_FLAGS` set (currently
  `flag.analytics, flag.ap_bills, flag.import_integrations, flag.forecasting,
  flag.pricing_tiers, flag.reports, flag.returns`) muted by a `PLAN_FLAG_ENFORCEMENT` kill
  switch, until a registry equivalent to the addon-gate one exists (per `CLAUDE.md`'s "Money
  discipline" section).
- **Plan/addon data model**: `PlanVersion` → `PlanDefinition`/`AddonSku` (global catalog, see
  B3) vs. per-tenant `TenantAddon`/`TenantSubscription`. The `crm_gohighlevel` addon is
  currently only reachable via the legacy free-text `TenantAddon.addonKey` path (no `AddonSku`
  published for it yet per the registry's own backfill text above) — CLAUDE.md's "Lite plan
  work in flight" note (invite-only LITE plan) is a live, adjacent change to this same catalog
  system; **exact current state of that LITE plan work is UNVERIFIED here** (not opened; noted
  as a constraint below only because CLAUDE.md flags it as in-flight).

### B5. Constraints for the planner (quoted/paraphrased from `CLAUDE.md` and the code read above)

- **Every model tenant-scoped** — confirmed pattern held for `ContactPerson`, `CustomerComment`,
  `SalesAgent`, `Message`, `MessageThread`, `AuditLog`, `CrmConnection`, `CrmHandoff`,
  `TenantAddon` above (all carry `tenantId`); `AddonSku`/`PlanVersion` are the deliberate,
  documented exception (global reference data).
- **Money math only via `@routeflow/pricing`** (`packages/pricing`) — api/web/mobile import it,
  no mirrors; commission math (`CommissionAccrual` etc.) is a candidate area a CRM overlap
  (e.g. deal value, quota) would need to respect, though `commission-math.ts` itself was not
  opened in this pass.
- **Mobile mirrors web** — any CRM UI added to web needs a mobile mirror per the project's
  stated convention; `apps/mobile` structure (multi-role `(auth)/(customer)/(driver)/
  (operator)/(tenant)`) was confirmed from the code map but CRM-specific mobile screens do not
  yet exist (no CRM/lead/deal hits in `mobile.md`).
- **Approved-test-tenant policy** — all CRM testing/seeding must use `test`, `e2e-routeflow`,
  `routeflow-demo`, or `qa-*`/`e2e-*`/`ux-audit-*` slugs (`scripts/lib/test-tenants.cjs`
  `assertTestTenant`), never a live client tenant.
- **No client identifiers in code** — any CRM fixtures/examples must use placeholder names
  (`acme`-style), not real tenant/customer data, consistent with the existing `crm` module's
  own generic naming.
- **Heavy files policy** — no images/videos/office binaries in git outside the named exceptions;
  relevant if CRM absorption implies bringing over Frappe CRM's `frontend/src/images/` assets.
- **Lite plan work in flight** — CLAUDE.md/MEMORY note an invite-only LITE plan is being built
  into the same billing/plan-catalog system a CRM add-on would need to slot into
  (`PlanVersion`/`PlanDefinition`/`AddonSku`); exact status **UNVERIFIED** (not opened this
  pass) but flagged as a moving part in the same subsystem.
- **Prisma schema is a folder, not a file** — a new CRM-adjacent model must be added to the
  domain file it belongs to (likely `sales.prisma` for CRM entities like leads/deals if they
  mirror `Customer`, or a new file) **and** to `MODEL_DOMAIN` in
  `apps/api/scripts/split-prisma-schema.mjs`, or `--check` fails (per `CLAUDE.md`).
- **`@LeaderCron`, never bare `@Cron`** — the existing `crm` module's poll job already follows
  this (`GoHighLevelCronRunner` in `crm.module.ts`); any new CRM background job must too.

---

## PART C — Gap matrix

| Frappe feature | RouteFlow equivalent or NONE | Notes |
|---|---|---|
| `crm_lead` (Lead) | **NONE** | RouteFlow has no pre-customer "lead" concept; the closest analog is a `CrmHandoff` row (an inbound GoHighLevel opportunity awaiting match to a `Customer`), which is a one-way sync artifact, not a first-class lead entity with its own status/pipeline. |
| `crm_deal` (Deal/opportunity) + `crm_deal_status` | **Partial — `CrmHandoff.status` (`CrmHandoffStatus`)** only for GHL-sourced opportunities | No native, provider-agnostic deal/pipeline entity; nothing tracks deal value, stage-by-stage probability, or a deal not sourced from GoHighLevel. |
| `crm_organization` | **RouteFlow `Customer`** (the `businessName`/`customerType` fields) | RouteFlow conflates "Organization" and "Customer/account" into one `Customer` model — there is no separate org entity distinct from the billing/ordering customer. |
| `crm_contacts` | **RouteFlow `ContactPerson`** | Close match structurally (name/email/phone/isPrimary, FK to the account); RouteFlow's version has no activity feed of its own, no title/role field seen, no dedup or comms-status tracking. |
| Pipeline / Kanban board | **NONE** | No UI or model in RouteFlow for a kanban-style stage board for anything CRM-shaped (routes/orders have their own status enums but nothing kanban-oriented was found in `web.md`/`mobile.md`). |
| Saved views / filters / sorting / column customization | **NONE found** | No `*_view_settings`-shaped model or per-user saved-view feature surfaced in the code map or schema for a CRM-style list. |
| Activities timeline (unified, per record) | **Partial — `CustomerComment` + `Customer.notes` + `AuditLog`** | Three separate, non-unified mechanisms: a single free-text `notes` field, an append-only `CustomerComment` list, and a generic cross-entity `AuditLog`. No single "timeline" view combining calls/emails/tasks/notes was found. |
| Notes (`fcrm_note`) | **`CustomerComment` / `Customer.notes`** | See above — RouteFlow's version is customer-scoped only; Frappe CRM's notes are generic and reusable per-lead/deal. |
| Tasks (`crm_task`) | **NONE found** | No task/to-do model surfaced tied to a customer or CRM record (routes/orders have their own workflow states, which are operational, not CRM tasks). |
| Email (in/out, templates, threads) | **Partial — `MessageTemplate`, `MessageThread` (channel `EMAIL`), `apps/api/src/email/`** | Schema explicitly flags this substrate as **not yet wired to a provider** ("NOTHING here is wired to a provider yet" — schema comment on `Message`); so today it is closer to a designed-but-dormant capability than a working inbox. |
| Calls (Twilio/Exotel) + call logs/recordings | **NONE found** | No call-log model, no Twilio/Exotel integration surfaced anywhere in the api code map or the modules read. |
| WhatsApp | **Partial — `MessageChannel.WHATSAPP` enum value exists** | Same dormant-substrate caveat as email above; no working WhatsApp provider integration confirmed. |
| SLA / response-time tracking | **NONE found** | No SLA/response-time model surfaced. |
| Assignment rules / round-robin | **Partial — `AgentAssignment` (sales-agent-to-customer assignment)** | This is a static commission/territory assignment, not a lead-routing/round-robin rule engine. |
| Lost reasons | **NONE found** | No lost-reason model; RouteFlow has no deal-stage concept to lose from in the first place. |
| Custom fields / form scripts / field layouts | **NONE found** | RouteFlow's schema is fixed Prisma models per tenant migration, not an end-user-configurable field/form-script system like Frappe's doctype customization layer. |
| Permissions / roles | **RouteFlow `UserRole`** (`SUPER_ADMIN, TENANT_ADMIN, OPERATOR, DRIVER, CUSTOMER` per api.md) + `@RequireAddon`/`@RequirePlanFlag` gates | Different model: RouteFlow uses a fixed role enum + entitlement gates, not Frappe's granular per-doctype permission rules. |
| Dashboards / analytics | **RouteFlow `analytics` module** (named in `CLAUDE.md`'s Architecture section, `apps/api/src/analytics`) | Existence confirmed via `CLAUDE.md`'s module list; contents/overlap with CRM-style deal analytics **UNVERIFIED** (not opened). |
| Import/export | **RouteFlow `import` module** (`apps/api/src/import/`, `ImportBatch`, `ImportQueueItem`, `MigrationJob`) | Generic import/migration infra exists and is already reused by the GHL handoff path; a Frappe-CRM-shaped lead/deal import would plug into the same substrate, though field-level mapping work is unverified/undone. |
| Integrations (ERPNext, Gmail, etc.) | **RouteFlow `crm` module (GoHighLevel only)** | RouteFlow's only CRM-shaped integration today is the one-way GoHighLevel handoff; no ERPNext or Gmail equivalent exists (RouteFlow is not an ERPNext-adjacent product). |
| Mobile support | **Partial — RouteFlow's mobile app mirrors web generally**, but no CRM-specific mobile screens exist yet | No `(operator)`/other role screens for leads/deals/pipeline were found in `mobile.md`. |
| Notifications | **RouteFlow `apps/api/src/notifications/` + `NotificationRule`/`MessageOptOut` models** | Directory and models exist; contents/maturity **UNVERIFIED** (not opened this pass). |
| REST API / webhooks | **RouteFlow's own NestJS REST API** (`/api/v1/*`, Swagger at `/api/docs` per `CLAUDE.md`) | RouteFlow already has a full REST surface; Frappe CRM's REST surface (Frappe's generic doctype REST + whitelisted methods) is architecturally unrelated and would not be reused as-is — this is a "different mechanism, same category" gap, not a missing capability. |

---

## Tool-budget notes for the reader

This pack was built under a 35-tool-call research budget. Areas explicitly left
**UNVERIFIED** and worth a deeper follow-up pass if the planner needs them: (1) the literal
text of Frappe CRM's `license.txt`/LICENSE file (only the GitHub API's SPDX id was confirmed);
(2) any separate docs/asset license; (3) field-level JSON schemas for every Frappe CRM doctype
(only doctype names were enumerated); (4) Frappe CRM's whitelisted-method/webhook API surface;
(5) contents of RouteFlow's `apps/api/src/{notifications,email,buyer,analytics}` modules beyond
their existence; (6) `commission-math.ts` internals; (7) exact current state of the in-flight
LITE plan work referenced by `CLAUDE.md`.
