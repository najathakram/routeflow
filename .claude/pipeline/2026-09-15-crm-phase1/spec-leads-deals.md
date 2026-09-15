# Frappe CRM — Lead & Deal Behaviour Spec (source: `frappe/crm` @ `develop`, read 2026-09-15)

Faithful, implementation-ready behaviour spec for porting Frappe CRM's Lead/Deal domain into
RouteFlow (NestJS + Prisma/Postgres, Next.js web, Expo mobile) **without** porting Frappe
framework code. Rules cite source path + line number (1-based within that file, as fetched from
GitHub `develop` on 2026-09-15). Unread/derived claims are marked **INFERRED**.

Standard/implicit fields on every doctype (`name`, `owner`, `creation`, `modified`,
`modified_by`, `idx`, `docstatus`) are **FRAMEWORK**, excluded from field tables below.

---

## 1. Entities

### 1.1 CRM Lead (`crm_lead.json`)

Naming: `naming_series` FRAMEWORK, `CRM-LEAD-.YYYY.-`. Port as a generated id, not the series.

| Field | Type | Req'd | Default | Options / Link | Notes |
|---|---|---|---|---|---|
| salutation | Link | | | Salutation | |
| first_name | Data | yes | | | |
| middle_name / last_name | Data | | | | |
| gender | Link | | | Gender | |
| status | Link | yes | | CRM Lead Status | list/kanban column, standard filter |
| email | Data | | | (Email) | |
| website | Data | | | | client normalizes to add `https://` before create |
| mobile_no / phone | Data | | | (Phone) | |
| no_of_employees | Select | | | 1-10\|11-50\|51-200\|201-500\|501-1000\|1000+ | |
| annual_revenue | Currency | | | non_negative | rejects negative (`NonNegativeError`) |
| lead_owner | Link | | | User | drives assignment, §2.5 |
| source | Link | | | CRM Lead Source | |
| industry | Link | | | CRM Industry | |
| image | Attach Image | | | | hidden, avatar |
| lead_name | Data | | | | **computed** (§2.1) |
| job_title | Data | | | | |
| organization | Data | | | | **plain text** (not a Link — contrast Deal) |
| converted | Check | | 0 | | **computed** by conversion; excluded from list filters |
| territory | Link | | | CRM Territory | |
| sla, sla_creation, sla_status, communication_status, response_by, first_response_time, first_responded_on, rolling_responses (table), last_response_time, last_responded_on | mixed | | `communication_status` default "Open" | CRM Service Level Agreement / CRM Communication Status | SLA engine, out of scope except as touch point (§2.6) |
| status_change_log | Table | | | CRM Status Change Log | §1.9 |
| products | Table | | | CRM Products | §1.8 |
| total / net_total | Currency | | | read_only, non_negative | **client-computed only**, never re-validated server-side |
| facebook_lead_id (unique) / facebook_form_id | Data | | | | lead-sync integration, out of scope |
| lost_reason | Link | | | CRM Lost Reason | required when status.type == "Lost" |
| lost_notes | Text | | | mandatory when lost_reason == "Other" | |
| organization_logo / company_description / linkedin / twitter / facebook | mixed | | | | domain-enrichment output, no_copy, shown only if set |

Permissions: System Manager / Sales Manager / Sales User all get full CRUD; row scoping is
separate (§3).

### 1.2 CRM Deal (`crm_deal.json`)

Naming: `naming_series` FRAMEWORK, `CRM-DEAL-.YYYY.-`.

| Field | Type | Req'd | Default | Options / Link | Notes |
|---|---|---|---|---|---|
| organization | Link | | | CRM Organization | **Link** (contrast Lead's plain text) |
| next_step | Data | | | | |
| status | Link | yes | | CRM Deal Status | |
| deal_owner | Link | | | User | §2.5 |
| probability | Percent | | | | auto-filled from status if unset (§2.2) |
| expected_deal_value / deal_value | Currency | | | non_negative | `expected_deal_value` auto-synced from net/total under a setting (§2.2) |
| expected_closure_date / closed_date | Date | | | | `closed_date` auto-set when status → "Won" |
| contacts | Table | | | CRM Contacts | §1.7; primary row drives email/mobile/phone |
| contact | Link | | | Contact | present in schema, **unreferenced by any controller/API read** — INFERRED vestigial, do not port without confirming a live usage |
| lead | Link | | | CRM Lead | set only by conversion |
| source | Link | | | CRM Lead Source | |
| lead_name | Data | | | | copied at conversion, plain data after |
| organization_name | Data | | | | free-text company name, distinct from the `organization` Link |
| website / annual_revenue / territory | mixed | | | `fetch_from` a `.<field>` | auto-populated from the linked Organization; exact Frappe fetch semantics for a bare `.field` — INFERRED "from this row's organization" |
| organization_logo / company_description / linkedin / twitter / facebook | mixed | | | | domain-enrichment output, no_copy |
| industry | Link | | | CRM Industry | |
| no_of_employees / job_title | Select/Data | | | | |
| salutation / first_name / last_name / gender / email / mobile_no / phone | mixed | | | | **all computed from the primary contact** (§2.3), not independently authoritative |
| currency | Link | | | Currency | |
| exchange_rate | Float | | 1 | | recomputed on currency change/unset (§2.2) |
| products / total / net_total | Table/Currency | | | CRM Products | same as Lead |
| SLA fields | mixed | | | | same shape as Lead |
| status_change_log | Table | | | CRM Status Change Log | |
| lost_reason / lost_notes | Link/Text | | | CRM Lost Reason | same rule as Lead |

Permissions: identical to Lead.

### 1.3 CRM Lead Status / 1.4 CRM Deal Status

Naming `field:lead_status` / `field:deal_status` — the label **is** the primary key.
Fields: status label (Data, required, unique = primary key), `type` (Select: Open, Ongoing, On
Hold, Won, Lost; default "Open"), `color` (Select, 13 named colors, default "gray"), `position`
(Int, manual sort). Deal Status adds `probability` (Percent) — its default value is copied onto
a Deal's own `probability` when that field is unset/0.

`type` is the behavioural switch: `type == "Lost"` gates `lost_reason`; a Lead defaults to
status `"New"` if it exists else the first `type == "Open"` status; a Deal defaults to
`"Qualification"` if it exists else the first `type == "Open"` status. `translated_doctype: 1`
— labels are translated in the UI layer, not stored per-locale.

### 1.5 CRM Lead Source

Naming `field:source_name`. Fields: `source_name` (Data, required, unique, PK), `details`
(Text Editor). System Manager/Sales Manager full CRUD; **Sales User is read-only** — the one
asymmetric permission set in this domain.

### 1.6 CRM Lost Reason

Naming `field:lost_reason`. Fields: `lost_reason` (Data, required, unique, PK), `description`
(Text Editor). Full CRUD for all three roles. `"Other"` is a magic string that makes
`lost_notes` mandatory on both Lead and Deal.

### 1.7 CRM Organization

Naming `field:organization_name` (name **is** the org name; renaming it renames the PK).
Fields: `organization_name` (Data, unique), `website`, `organization_logo` (Attach Image,
`image_field`), `no_of_employees` (Select, same options as Lead/Deal), `annual_revenue`
(Currency, non_negative), `industry` (Link), `territory` (Link), `currency` (Link), `exchange_rate`
(Float, default 1), `address` (Link→Address), `company_description`/`linkedin`/`twitter`/
`facebook` (domain-enrichment output). Full CRUD for all three roles.

Controller: `validate()` recomputes `exchange_rate` against `FCRM Settings.currency` (default
"USD") whenever `currency` changed or is unset — 1:1 if same as system currency, else an
external rate lookup (`crm.api.exchange_rate.get_exchange_rate`, not read — **INFERRED**).
`after_insert()` best-effort triggers domain enrichment from the website (background job,
**INFERRED** fill-empty only; the `domain_enrichment` package itself is out of scope of this
port unless requested separately).

### 1.8 CRM Contacts (child table, Deal only)

`contact` (Link→Contact); `full_name`/`email`/`mobile_no`/`phone`/`gender` all
`fetch_from: contact.<field>`, read_only — a live mirror of the Contact, not independently
editable; `is_primary` (Check, default 0). Exactly one row may be primary (§2.3); a single-row
table auto-promotes to primary.

### 1.9 CRM Status Change Log (child table, Lead + Deal)

`from`/`to` (Data — status **label**, not a Link, so history survives rename/delete),
`from_type`/`to_type` (Data — the status's `type` at that time), `from_date`/`to_date`
(Datetime), `duration` (Duration, seconds), `last_status_change_log` (Link→self, unused by the
read controller — **INFERRED** vestigial), `log_owner` (Link→User). Built entirely by
`add_status_change_log()` (§2.4) — never authored by a user directly.

### 1.10 CRM Products (child table, Lead + Deal)

`product_code` (Link→CRM Product), `product_name` (Data, required), `qty` (Float, default 1),
`rate` (Currency, required), `discount_percentage` (Percent), `discount_amount`/`amount`/
`net_amount` (Currency, read_only, computed: `amount = rate*qty`, `net_amount = amount -
discount_amount`). **All roll-up math is client-side only** (`update_total` in the `.js`
controllers) — the parent's `total`/`net_total` are never recomputed server-side. Do not port
this as-is: RouteFlow's `packages/pricing` server-side computation is mandatory per house money
discipline — treat client-only math as a defect to fix, not a behaviour to preserve.

### 1.11 CRM Rolling Response Time (child table)

`response_time` (Duration, read_only), `responded_on` (Datetime, read_only), `status` (Select:
Fulfilled/Failed, read_only). Populated by the SLA engine (out of scope).

### 1.12 Reference lists

- **CRM Communication Status**: `status` (Data, unique, PK). `"Open"` is the Lead/Deal default;
  `"Replied"` is set on lead conversion when it exists (§2.4).
- **CRM Industry**: `industry` (Data, unique, PK, translated).
- **CRM Territory**: tree doctype, nested-set `lft`/`rgt` FRAMEWORK; `territory_name` (unique,
  PK), `territory_manager` (Link→User), `parent_crm_territory` (Link→self), `is_group` (Check).
  Port as a self-referencing hierarchy; recompute subtree queries via recursive CTE or a
  closure table instead of nested-set bookkeeping.

---

## 2. Behaviours

Line numbers are 1-based within that individual file as fetched from `develop` on 2026-09-15.

### 2.1 Lead lifecycle (`crm_lead.py`)

- **`before_insert` (l.78)** — calls `crm.api.form.enrich_form_submission` (not read; web-form
  capture enrichment — **INFERRED** out of scope unless RouteFlow has a public lead-capture form).
- **`before_validate` → `set_sla` (l.416)** — no-op if `sla` set; else looks up an applicable SLA
  (engine out of scope) or clears `first_responded_on`/`first_response_time`.
- **`validate()` (l.87)**, in order:
  1. `validate_status` (l.114) — new Lead, no status → `"New"` if it exists else first
     `type=="Open"` status (**edge case**: `IndexError` if none seeded at all).
  2. `set_full_name` (l.121) — `lead_name` = space-joined `[salutation, first_name, middle_name,
     last_name]`, empty parts skipped.
  3. `set_lead_name` (l.134), only if still empty — no `organization`, no `email`, not
     `flags.ignore_mandatory` → throws "A Lead requires either a person's name or an
     organization's name"; else `organization` → email local-part → literal `"Unnamed Lead"`
     (last one only reachable via `ignore_mandatory`, i.e. import).
  4. `set_title` (l.146) — `title` = `organization` or `lead_name` (drives search-index title;
     **INFERRED** Frappe auto-adds a hidden title field when `index_web_pages_for_search` is on).
  5. `validate_email` (l.149) — malformed email throws unless `flags.ignore_email_validation`;
     `email == lead_owner` throws "Lead Owner cannot be same as the Lead Email Address".
  6. `validate_lost_reason` (l.157) — status type == "Lost" → throws if `lost_reason` empty, or
     (differently worded) if `lost_reason=="Other"` and `lost_notes` empty. Any status change
     also toggles a UI sidepanel section (not read — **INFERRED**, RouteFlow just conditions the
     section on status type client-side, no server call needed).
  7. not new, `lead_owner` changed and truthy → `share_with_agent` then `assign_agent` (l.169,
     §2.5).
  8. `status` changed → `add_status_change_log` (§2.4).
- **`after_insert` (l.100)** — `lead_owner` set → share (if owner ≠ creator) + assign; best-effort
  domain enrichment from `website` (out of scope).
- **`before_save` → `apply_sla` (l.111)** — no-op if no `sla`; else re-applies the SLA doc's rules
  (out of scope).
- **Dedup — `contact_exists` (l.319)**: matches **email only**, via the `Contact Email` child
  table; a mobile-only match is deliberately not a duplicate (verified by
  `test_contact_not_reused_when_only_phone_matches`). `throw=True` default raises "Contact
  already exists with Email: {email}"; conversion calls with `throw=False` to reuse instead.
- **`create_organization` (l.251)** — no `organization` text and no override → no-op (`None`).
  Else exact-name lookup on `CRM Organization`; found → `db_set` the id onto the Lead and
  best-effort `copy_enrichment_from_organization` (l.277, fill-empty only, never overwrites a
  user-set value); not found → create new, seeded from `organization`, `website`, `territory`,
  `industry`, `annual_revenue`, `no_of_employees`.
- **`create_deal(contact, organization, deal=None)` (l.338)** — the conversion field-mapper:
  - Copies every Lead meta field to the Deal except layout fieldtypes (Tab/Section/Column Break,
    HTML, Button, Attach) and a blocklist: `name`, `naming_series`, `creation`, `owner`,
    `modified`, `modified_by`, `idx`, `docstatus`, `status`, `email`, `mobile_no`, `phone`, `sla`,
    `sla_status`, `response_by`, `first_response_time`, `first_responded_on`,
    `communication_status`, `sla_creation`, `status_change_log`.
  - Field-name map: `lead_owner`→`deal_owner`; same-named fields copy 1:1; a **custom field**
    with no name match copies only if exactly one Deal custom field shares its **label and
    fieldtype** (ambiguous or absent → dropped silently).
  - `organization` set to the **resolved id** (not raw text); always sets `lead` = the Lead's
    name and seeds `contacts = [{contact}]`.
  - Lead has `first_responded_on` set → copies the whole SLA snapshot onto the Deal (else the
    Deal starts its own SLA clock).
  - Caller-passed `deal` dict (e.g. from the required-fields modal) is applied last and wins over
    every copied field.
  - Inserts `ignore_permissions=True`; every Lead assignee who isn't already the Deal's owner is
    also assigned to the Deal — **all assignees carry over, not just the owner**.
- **`convert_to_deal(lead, doc=None, deal=None, existing_contact=None, existing_organization=None)`**
  (whitelisted, l.523):
  1. Requires Lead `write` permission unless `doc.flags.ignore_permissions`.
  2. Status type == "Lost" → throws "Cannot convert a lead with status {status}" (gate is on
     `type`, verified for both "Junk" and "Unqualified" statuses).
  3. If a status literally named `"Qualified"` exists, `db_set`s it onto the Lead (bypasses
     `validate()`); otherwise status is left unchanged.
  4. `converted` → `1` (`db_set`) — the flag `Leads.vue` hardcodes `filters:{converted:0}` on
     (§5.1).
  5. Lead has an `sla` and a `"Replied"` Communication Status exists → set it.
  6. `create_contact(existing_contact, throw=False)` → `create_organization(existing_organization)`
     → `create_deal(...)`; returns the new Deal name.

### 2.2 Deal lifecycle (`crm_deal.py`)

- **`before_insert`/`before_validate`** — same `enrich_form_submission`/`set_sla` shape as Lead.
- **`validate()` (l.89)**, in order:
  1. `validate_status` (l.120) — no status → `"Qualification"` if it exists else first
     `type=="Open"` (same `IndexError` risk).
  2. `set_primary_contact()` (l.127) — no explicit contact arg, exactly one `contacts` row →
     force `is_primary=1` on it.
  3. `set_primary_email_mobile_no()` (l.140, §2.3).
  4. not new, `deal_owner` changed and truthy → share + assign (§2.5).
  5. `status` changed → `add_status_change_log`; **and** new status type == "Won" → `closed_date`
     = today, set directly here — redundant with step 6's `update_closed_date` (both run every
     save; the second is a no-op once set).
  6. `validate_forecasting_fields()` (l.270): `update_closed_date` (l.245, guarded by
     `not self.closed_date`) → `update_default_probability` (l.252 — `probability` falsy/zero →
     copy the Deal Status's own `probability`) → `update_expected_deal_value` (l.259 — setting
     `auto_update_expected_deal_value` on, **and** `(net_total or total)` truthy, **and**
     `expected_deal_value` already truthy → overwrite it with `net_total or total`; a Deal with
     **no** `expected_deal_value` yet is left alone even with the setting on). Then, setting
     `enable_forecasting` on → `expected_deal_value` and `expected_closure_date` become hard
     `MandatoryError`s if either is falsy/zero.
  7. `validate_lost_reason()` (l.280) — identical shape to Lead's.
  8. `update_exchange_rate()` (l.292) — `currency` changed or `exchange_rate` falsy → 1:1 if
     equal to system currency (`FCRM Settings.currency`, default "USD"), else external lookup;
     written via `db_set` **inside** `validate()` — persisted immediately even if the rest of the
     save later fails; note this pattern when porting (don't let a rejected save leave a
     half-applied DB write like this).
  9. `organization` set and (new or changed) → best-effort `copy_enrichment_from_organization`
     (fill-empty only).
- **`after_insert`/`before_save`** — same owner-assign/share and `apply_sla` pattern as Lead.
- **`add_contact` / `remove_contact` / `set_primary_contact`** (whitelisted, l.377/388/399) —
  permission-check Deal `write`, mutate `contacts`, `save()`. `remove_contact` filters the row
  out with no API-level confirmation (the modal owns any "are you sure").
- **`create_organization` / `contact_exists` / `create_contact`** (l.410/435/448) — used only by
  the standalone **"Create Deal"** flow, not lead conversion (which uses the Lead's own
  same-named methods). Dedup here is **broader**: `contact_exists` (l.435) checks **both**
  `Contact Email` and `Contact Phone` (email first) — a real divergence from the Lead's
  email-only dedup.
- **`create_deal(doc: dict)`** (whitelisted, l.476) — the "Create Deal" modal's call: no
  `contact` id but any of first/last name/email/mobile present → creates a Contact first via the
  helper above; resolves `organization` the same dedup-or-create way from `organization_name`.
  Inserts `ignore_permissions=True`.

### 2.3 Deal primary-contact invariant

- At most one `contacts` row may have `is_primary=1`; more than one → "Only one Contact can be
  set as primary." (thrown in `validate()`, so a bulk edit leaving two primaries fails the whole
  save).
- Deal's own `email`/`mobile_no`/`phone` are a **read-through of the primary contact**: every
  `save()` recomputes them from the primary row (trimmed), and forces all three to `""` if no
  row is primary (including an empty `contacts` table).
- A single-row table with no `is_primary` set is auto-promoted to primary during `validate()`.
- `crm.api.contact.validate` (doc-event on the standard `Contact` doctype, `contact.py:5`, wired
  via `hooks.py` `doc_events["Contact"]["validate"]`) keeps this live in the other direction:
  saving a Contact **directly overwrites** (`frappe.db.set_value`, bypassing Deal's own
  `validate()`) `email`/`mobile_no` on every Deal for which that Contact is the **primary**
  contact, if drifted. Editing a shared Contact propagates to every Deal it's primary on,
  without going through the Deal's save pipeline at all.

### 2.4 Status-change audit log (`crm_status_change_log.py:45`)

`add_status_change_log(doc)`, called from both controllers' `validate()` whenever `status`
changed. Looks up the **new** status's `type` — reads it unconditionally from
`"CRM Deal Status"` (l.142), a **latent upstream bug** on the Lead side whenever a Lead status
name doesn't also exist as a Deal status name (returns `None`); RouteFlow should look up `type`
from the correct doctype per entity instead of copying this. Not new, log currently empty, and
there was a previous status → back-fills a synthetic first row (`from`=previous status,
`to`="", `from_date`=now-1min, so a duration is computable). Always closes the **last** open row
(`to`/`to_type`/`to_date`=now, `duration`=elapsed seconds) and appends a new open row
(`from`=new status, `to`=""). Net invariant: exactly one row has empty `to` at any time,
representing "in this status since `from_date`". First-ever save only appends (nothing to
close).

### 2.5 Owner ↔ assignment sync (Lead, Deal, and the generic `ToDo` doctype)

The most important cross-cutting rule — implemented as a `ToDo` doc-event hook
(`hooks.py:171-175` → `crm/api/todo.py`), not on the Lead/Deal controllers alone. Frappe's
assignment UI creates one `ToDo` row per assignee per document.

- **`validate` (l.8)** — a brand-new `ToDo` directly against a Lead/Deal (not via the trusted
  `assign_to`/assignment-rule paths, which set `flags.ignore_permissions`) requires the creator
  to have `write` on that record, else `PermissionError`.
- **`after_insert` (l.21)** — new `ToDo` with an `allocated_to` → `lead_owner`/`deal_owner` is
  force-set to `allocated_to` via `frappe.db.set_value(update_modified=False)` — **the newest
  assignment always becomes owner**, unconditionally, even over an existing owner. Also
  notifies the assignee (Lead, Deal, and CRM Task references).
- **`on_update` (l.33)** — a `ToDo`'s status → `"Cancelled"` fires an unassigned notification
  and, for Lead/Deal only (not Task), **clears the owner entirely** (`clear_owner_on_unassign`,
  l.45) regardless of other remaining assignees. **Accepted upstream wrinkle**: with two
  assignees, cancelling the **non-owner's** assignment still nulls the owner field, because
  owner is single-valued but the assignee list isn't. Decide deliberately whether RouteFlow
  keeps or fixes this.
- **`assign_agent`** (`crm_lead.py:169`, `crm_deal.py:164`) — used when `lead_owner`/
  `deal_owner` is set directly on the document: idempotent no-op if already an assignee, else
  creates the `ToDo` via Frappe's `assign_to._add(ignore_permissions=True)` (re-entering
  `after_insert` above, harmlessly, since the owner is already set).
- **`share_with_agent`** (`crm_lead.py:182`, `crm_deal.py:177`) — grants document **share**
  access to the new owner and revokes it from every previously-shared non-owner user.
  Idempotent. This is how a user without row visibility (§3) still sees a record they own.
- Port contract: **owner is a derived, single-valued projection of "most recently assigned
  user"**; reassignment is unassign-then-assign in one atomic UI action upstream (per
  `test_reassignment_moves_owner`) — mirror that as one atomic "reassign" operation to avoid a
  moment where owner is null mid-transition.

### 2.6 SLA touch points (engine out of scope)

`sla`, `sla_status`, `sla_creation`, `communication_status`, `response_by`,
`first_response_time`, `first_responded_on`, `last_response_time`, `last_responded_on`,
`rolling_responses` are written **only** by `set_sla`/`apply_sla` (SLA engine, not read) and by
conversion's SLA-snapshot copy (§2.1) — no other controller writes them. Conversion also sets
`communication_status = "Replied"` when an SLA is active. Treat the SLA subsystem as a separate
absorption task; here it's only guaranteed to exist as UI-displayed fields (`SLASection.vue`,
badge + due/failed/fulfilled state, not read in detail).

### 2.7 Activity timeline (`crm/api/activities.py`)

`get_activities(name)` (whitelisted; checks Deal first, then Lead, else `DoesNotExistError`)
merges for one record:
- A **creation** entry, first chronologically: "created this lead/deal", or — Deal has a
  non-empty `lead` and the caller can read that Lead → "converted the lead to this deal" **and
  the whole Lead's own timeline is prepended** (recursive call). If the caller can read the Deal
  but not the source Lead, the Lead's history is silently skipped (not an error).
- **Field-change entries** from Frappe's Version log, filtered to fields the user has read
  access to (`get_permlevel_access`) and outside a small blocklist (Lead: `converted`,
  `response_by`, `sla_creation`, `sla`, `first_response_time`, `first_responded_on`; Deal:
  `lead` + the same SLA fields); classified added/removed/changed by which diff side is empty;
  consecutive same-owner entries are grouped (`handle_multiple_versions`) so one multi-field
  save doesn't spam the timeline.
- **Comments**, **communications** (emails incl. automated) with attachments, **attachment
  add/remove log entries**, **calls** (`CRM Call Log`, matched by `reference_docname` or via a
  `Dynamic Link` — the latter is how one call attaches to a Lead/Deal *and* a Note/Task at once),
  **notes**/**tasks** linked by `reference_docname` — all merged, sorted creation-descending.
- Field values are translated (`_()`) when their `options` doctype is in Frappe's
  translated-doctypes set — how status/lost-reason labels localize in the timeline with no
  separate i18n table.

---

## 3. Permissions

Base matrix (`crm_lead.json`/`crm_deal.json`): **System Manager**, **Sales Manager**, **Sales
User** all get full CRUD on both CRM Lead and CRM Deal — no built-in read-only/no-delete tier
for these two doctypes; access below role level is name/hierarchy based (CRM Lead Source is the
one exception, §1.5).

Row-level scoping (`crm/permissions/org_hierarchy.py`, wired as `permission_query_conditions`
and `has_permission` for both doctypes):

- `Administrator` / `System Manager`: unrestricted.
- **Hierarchy disabled** (`FCRM Settings.enable_sales_hierarchy` false, default, l.14-15):
  `Sales Manager` unrestricted; everyone else sees only records where
  `lead_owner`/`deal_owner == self`, or with a non-cancelled `ToDo` assignment to self (l.54-61).
- **Hierarchy enabled** and the user is a node in `CRM Sales Hierarchy` (nested-set subtree,
  l.29,107-120): even a Sales Manager loses blanket visibility and is scoped like everyone
  (l.32-33,89-90) — visible = owned/assigned by self **or any subtree member** (l.39-52). A
  Sales Manager **not** in the tree still gets the unrestricted default.
- `has_lead_permission`/`has_deal_permission` (single-doc check, e.g. `convert_to_deal`'s
  `frappe.has_permission` call) mirror the same condition set via a scalar existence query, so
  list and single-doc checks never disagree.
- `share_with_agent` (§2.5) is the escape hatch letting an owner outside normal visibility still
  access their own record — port as an explicit per-user ACL row for the current owner, applied
  in addition to (not instead of) the ownership/hierarchy filter.

Convert-to-deal requires Lead **write** only — no separate "convert" permission.

---

## 4. API surface

All are Frappe whitelisted Python functions called `POST /api/method/<dotted.path>` (JSON body =
kwargs by name; error shape `{exc_type, exception, messages: [...]}`, which the frontend
destructures directly, e.g. `ConvertToDealModal.vue`'s `MandatoryError` field-name parsing).

| Method | Params | Returns | Notable errors |
|---|---|---|---|
| `crm_lead.convert_to_deal` | `lead`, `doc?`, `deal?`, `existing_contact?`, `existing_organization?` | new Deal name | `PermissionError`; `ValidationError` "Cannot convert a lead with status {status}"; `MandatoryError` per unfilled required Deal field |
| `crm_deal.create_deal` | `doc` (dict) | new Deal name | `MandatoryError`/`ValidationError` |
| `crm_deal.add_contact` / `remove_contact` | `deal`, `contact` | `true` | `PermissionError` |
| `crm_deal.set_primary_contact` | `deal`, `contact` | `true` | `PermissionError` |
| `crm_deal.api.get_deal_contacts` | `name` | `[{name, image, full_name, email, mobile_no, is_primary}]`, primary first | `PermissionError` |
| `crm.api.contact.get_linked_deals` | `contact` | `[{name, organization, currency, deal_value, status, email, mobile_no, deal_owner, modified}]` | `PermissionError` |
| `crm.api.contact.create_new` / `set_as_primary` | `contact, field, value` | `true` | `PermissionError`; "Invalid field" for unknown `field` |
| `crm.api.contact.search_emails` | `txt` | `[[full_name, email_id, name], ...]`, max 20 | — |
| `crm.api.activities.get_activities` | `name` | `[activities, calls, notes, tasks, attachments]` | `DoesNotExistError`; `PermissionError` |
| `frappe.client.insert` (generic FRAMEWORK) | `{doc:{doctype:"CRM Lead", ...}}` | inserted doc | standard validation |

**Asymmetry to fix, not port**: Lead creation uses the **generic** `frappe.client.insert` (no
dedicated `create_lead`), while Deal has a **dedicated** `create_deal` with inline
contact/organization dedup-or-create. RouteFlow should give both a proper dedicated endpoint
(`POST /leads`, `POST /deals`) with the same dedup-or-create behaviour on both sides.

List/kanban/group-by data is served by a generic, doctype-agnostic Frappe list/report engine
(behind `ViewControls.vue`, FRAMEWORK, not detailed here) returning `{data, columns, rows,
view_type,...}`. Don't port it generically — build purpose-built `GET /leads`/`GET /deals`
matching §5.1/§5.3's actual requirements.

---

## 5. UI behaviour

Per owner ruling: behaviour and information architecture only. Patterns are named generically
(list, kanban board, side panel, tabs, inline edit) for RouteFlow's existing design system to
implement; no Frappe colour/spacing/component detail is specified here.

### 5.1 Leads list / Deals list

- Three interchangeable views over the same record set: **list** (sortable/filterable table,
  resizable/reorderable columns, infinite "load more"), **grouped list** (records bucketed under
  collapsible headers by a chosen field; status grouping shows a colour indicator per group),
  **kanban** (§5.3). The active view + its filters/sort/columns is a persisted, shareable
  per-user "saved view" — treat as a saved-filter-preset feature, not detailed further.
- **Leads list defaults to `converted = false`**, not removable from this screen (a converted
  Lead stays reachable via its Deal, or a saved view that removes the filter). **Deals list has
  no equivalent filter** — shows every Deal.
- Default columns — Leads: Full Name, Organization, Status, Email, Mobile No., Assigned To,
  Last Modified. Deals: Organization, Annual Revenue (right-aligned), Status, Email, Mobile No.,
  Assigned To, Last Modified. Both default-sort by Last Modified descending.
- Standard filter fields: Leads — status, email, organization, lead_name, converted; Deals —
  status, organization, email.
- Row actions (overflow menu, hover, both list and kanban): "Make a Call" (only if telephony
  enabled and a mobile number exists), "New Note", "New Task" (each opens a quick-create
  pre-linked to the record). Each row also shows 4 counters: email, note, task, comment.
- Header **Create** button opens a quick-create dialog with a (admin-configurable, treat as
  fixed for the port) required-fields form.
- Distinct empty vs. loading placeholder states.

### 5.2 Lead detail / Deal detail

Two-pane layout: tabbed main content + a resizable/collapsible side panel (identity, quick
actions, field sections).

- **Header**: breadcrumb (List → active saved view → record title), record-specific custom
  actions (admin-scriptable, out of scope), a domain-enrichment trigger (enabled only if
  website is set), an assignment control (multi-user picker, add/remove), a status dropdown
  (coloured pill showing current status, all same-doctype statuses as options, applies
  immediately subject to the lost-reason gate below). Lead only: "Convert to Deal", disabled
  with a tooltip when current status type is "Lost".
- **Identity block**: avatar (Lead: uploadable photo → org logo → initials; Deal: organization
  logo only, sourced from the linked Organization, not directly uploadable), title (Lead: full
  name; Deal: organization name), fixed action row: Call / Email / Website (each
  disabled-with-toast if the underlying field is unset) / Attach file / Delete
  (permission-gated, confirm-and-list-linked-docs dialog first).
- **SLA block**: shown only if an SLA is active — due/failed/fulfilled state (§2.6, out of scope
  to detail further).
- **Fields panel**: sectioned fields (admin-configurable layout; a fixed section layout per
  §1.1/§1.2 suffices for the port unless per-tenant layouts are required). Deal adds a
  **Contacts section**: expandable linked-contact list (avatar, name, "Primary" badge,
  email/phone once expanded; the primary row starts expanded), add-existing-or-create-new
  control, per-contact menu (View, Remove, "Set as Primary" — hidden on the already-primary row).
- **Status → Lost gate**: setting a "Lost"-type status intercepts save — if `lost_reason` is
  already non-"Other", or is "Other" with `lost_notes` filled, save proceeds; else a required
  dialog asks for Lost Reason (inline create-new supported) and, only when reason is "Other",
  Lost Notes. Cancelling reverts the status field to its previous value (no partial save).
- **Main tabs**: Activity (§2.7), Emails (thread + inline compose), Comments, Data (raw
  field-value dump, a fallback view), Calls, Tasks, Notes, Attachments, WhatsApp (conditional on
  integration). Last-active tab remembered per doctype (not per record).
- Editing any side-panel field, status, or image **autosaves immediately** (no separate Save
  button in the detail view) with optimistic update and rollback-on-error.
- Unsaved-changes navigation guard applies to in-flight modal/quick-create forms layered on top.

### 5.3 Kanban board (Leads and Deals)

- **Grouping field defaults to `status`** (configurable in principle; status is the only one
  exercised by the read code). One column per distinct value; user-reorderable, individually
  hideable/re-addable (hiding a column hides the status, doesn't touch its records).
- **Dragging a card to another column changes that record's `status`** to the target value,
  through the same save path and Lost-reason gate as the detail view. Reordering within a
  column changes only a per-column manual sort, not any record field.
- Each card: a configurable title field (default Lead full name / Deal organization name) with a
  type-appropriate leading icon/avatar, fixed secondary fields, a divider, the same 4 activity
  counters + overflow menu as the list view. Per-column pagination ("Load More"). Per-column
  "new record" pre-fills the grouping field (e.g. new Lead from the "Qualified" column starts
  `status = Qualified`).

### 5.4 Modals

- **Create Lead / Create Deal**: single-step, admin-configured required-fields form;
  client-side checks (first name required for Lead; numeric checks on revenue/mobile; email
  shape; status required for both). Success navigates to the new record's detail page.
- **Convert to Deal**: two toggles (existing-organization vs. create-new; existing-contact vs.
  create-new — default create-new, pre-filled from the Lead), plus the required-fields form
  pre-filled per §2.1's mapping. `MandatoryError` surfaces per-field ("{Field} is required").
- **Lost Reason**: auto-triggered by the Lost-status gate; reason (required, inline create-new)
  + notes (required only when reason is literally "Other"). Cancel reverts the pending status
  change.

### 5.5 Keyboard shortcuts

None found in any Lead/Deal-specific file read. **INFERRED** none exist beyond the generic
list/table component's own — out of scope, not Lead/Deal-specific.

---

## 6. Framework dependencies

| `frappe.*` primitive | Used for | Native equivalent |
|---|---|---|
| `get_doc`/`get_cached_doc`/`new_doc` | ORM load/create; cached variant avoids re-fetch in-request | Prisma `findUniqueOrThrow`/`create` + an in-request memoization cache |
| `db.exists`/`db.get_value(s)`/`get_all` (unchecked) vs. `get_list` (permission-checked) | raw vs. checked queries | Prisma queries; make the checked path the default, require explicit opt-out for raw |
| `doc.db_set(field, value)` | persist one field immediately, skipping `validate()`/hooks | a direct Prisma `update` that intentionally bypasses the service validation pipeline — flag these sites as the exception |
| `has_permission`/`check_permission` | row-level check (bool vs. throwing) | a NestJS guard/policy service, both boolean and asserting forms, backed by §3's rules |
| `permission_query_conditions`/`has_permission` hooks | inject a WHERE clause into every list query; gate single-doc reads the same way | a repository-layer filter applied uniformly to every Lead/Deal query |
| `assign_to._add`/`.remove` (via `ToDo`) | create/cancel an assignment, cascading to owner sync (§2.5) + notification | a dedicated `Assignment` service method (not a generic "create a todo") that atomically updates assignees + derived owner and emits the notification |
| `frappe.share.add_docshare`/`.remove` | per-user ACL grant/revoke, independent of role | an explicit per-record ACL table checked alongside the ownership/hierarchy rule |
| typed exceptions (`ValidationError`, `MandatoryError`, `PermissionError`, `NonNegativeError`, `DoesNotExistError`) | user-facing, i18n'd errors | NestJS exception classes → HTTP 400/403/404 with the same field-level shape the frontend already parses (§4) |
| `get_meta`/`doc.meta.fields` (runtime introspection) | drives the Lead→Deal field-mapping in `create_deal` (§2.1) | a static, build-time field-mapping table — don't port runtime meta-introspection; the map is fully enumerable from the Prisma schema |
| `frappe.enqueue` (implied, not directly read) | async/background job dispatch (domain enrichment, lead sync) | the existing job queue in the NestJS stack |
| `frappe.publish_realtime`/Socket.io (`$socket.on('crm_customer_created', ...)`) | server→client push on async job completion | RouteFlow's existing Redis/Socket.io channel |
| Document lifecycle hooks (`before_insert`, `before_validate`, `validate`, `after_insert`, `before_save`) | ordered, free lifecycle points per doctype | an explicit ordered private-method sequence in the service, not a generic hook registry |
| Document **Version** log (`get_docinfo`) | automatic field-change history for the timeline (§2.7) | an explicit audit-log table, or a Prisma middleware diffing/recording changed fields per update |
| `frappe.qb` + nested-set (`lft`/`rgt`) queries | subtree-membership query for the sales hierarchy (§3) | a recursive CTE or a maintained closure table |
| `validate_email_address` | email shape check | `class-validator @IsEmail` in the DTO layer |
| Naming series (`autoname: naming_series:`) | `CRM-LEAD-.YYYY.-00001`-style ids | RouteFlow's own id scheme — don't port the series format unless human-readable numbers are wanted |

---

## 7. Test cases

Given/When/Then. `[upstream]` = transcribed from real, passing Frappe CRM tests
(`test_crm_lead.py`, `test_crm_deal.py`) — port as regression tests as-is. The rest are net-new
edge-case coverage derived from §2's code paths.

**Lead naming / validation**

1. `[upstream]` Lead with `first_name="John", last_name="Doe"` → `lead_name == "John Doe"`.
2. `[upstream]` Lead with salutation + first/middle/last name → all four space-joined into
   `lead_name`.
3. `[upstream]` Lead with `email="not-an-email"` → validation error, nothing persisted.
4. `[upstream]` Lead with only `organization="Tech Corp"` → `lead_name == title == "Tech Corp"`.
5. `[upstream]` Lead with only `email="contact@company.com"` → `lead_name == "contact"`.
6. `[upstream]` Lead with none of name/org/email, no `ignore_mandatory` → throws "A Lead
   requires either a person's name or an organization's name".
7. Same as #6 but with `flags.ignore_mandatory=True` (bulk import) → `lead_name=="Unnamed Lead"`.
8. `[upstream]` Lead with `organization` set → `title == organization` (wins over lead_name).
9. `[upstream]` Lead with `email == lead_owner` → throws "Lead Owner cannot be same as the Lead
   Email Address".
10. `[upstream]` New Lead, no `status` → defaults to "New" (or first Open-type status).
11. `[upstream]` Lead created with `annual_revenue=-100` (also `total`, `net_total`) →
    `NonNegativeError` per field.

**Lost-reason gate (Lead and Deal, same rule)**

12. `[upstream]` Status → Lost-type with no `lost_reason` → throws "Please specify a reason for
    losing the {lead|deal}."
13. `[upstream]` `lost_reason=="Other"`, `lost_notes` empty, Lost-type status → throws asking to
    specify the reason in notes.
14. `lost_reason` set to anything else (notes empty), Lost-type status → save succeeds.

**Contact/organization dedup on Lead**

15. `[upstream]` Existing Contact email matches the Lead's → `create_contact(throw=True)` throws
    "Contact already exists with Email: {email}".
16. `[upstream]` Lead's `mobile_no` matches an existing Contact's phone, emails differ/absent →
    a **new**, distinct Contact is created (phone-only match ≠ duplicate).
17. `[upstream]` Two Leads share identical `organization` text → both `create_organization()`
    calls return the **same** org (no duplicate).
18. Lead's `organization` resolves to an already-enriched org → enrichment fields copy onto the
    Lead **only where empty** (never overwrite an existing Lead value).

**Lead → Deal conversion**

19. `[upstream]` Full Lead (contact + org + revenue) → `convert_to_deal()`: Lead `converted=1`;
    new Deal with `lead` back-linked and mapped fields (names, org, revenue) equal; new Contact
    + new Organization created and linked.
20. `[upstream]` `existing_contact`/`existing_organization` passed → Deal links those exact
    records instead of creating new ones, even if Lead's own `organization` text differs.
21. `[upstream]` Lead status type == "Lost" → `convert_to_deal` throws "Cannot convert a lead
    with status {status}"; Lead `converted` stays falsy.
22. `[upstream]` Lead `no_of_employees="201-500"`, no existing org → the **newly created
    Organization** (not just the Deal) has `no_of_employees=="201-500"`.
23. `[upstream]` Custom field `custom_lead_conversion_region` (Lead) and same-label/fieldtype
    `custom_deal_conversion_region` (Deal) → value copies across despite differing fieldnames.
24. `[upstream]` Lead with two assignees (owner + one more) → both end up assigned to the Deal.
25. Lead has `first_responded_on` set (SLA engaged) → Deal's SLA snapshot fields are copied
    verbatim instead of starting a fresh clock.
26. Caller without Lead `write` calls `convert_to_deal` directly → `PermissionError`, no Deal
    created.
27. Deal created via conversion; caller can read the Deal but not the source Lead → activity
    timeline renders using only the Deal's own history (Lead history silently omitted).

**Deal primary-contact invariant**

28. `[upstream]` Deal with exactly one contact row, no `is_primary` → auto-marked primary; Deal
    email/mobile/phone mirror that contact.
29. `[upstream]` Two contact rows both `is_primary=1` → throws "Only one Contact can be set as
    primary."
30. `[upstream]` Primary contact un-marked with no replacement chosen → Deal email/mobile/phone
    all cleared to `""`.
31. `[upstream]` Deal's primary Contact has its `email_id` changed directly → Deal's `email`
    updates to match, without going through the Deal's own `validate()`.

**Owner / assignment sync**

32. `[upstream]` Lead/Deal with no owner, user assigned via a `ToDo` insert → owner set to that
    user.
33. `[upstream]` Lead/Deal owned by A, user B newly assigned → owner becomes B (newest wins),
    even with A's assignment still active.
34. `[upstream]` Lead/Deal owned by A with only that one assignment, A's assignment cancelled →
    owner becomes null.
35. `[upstream]` Deal owned by A with a second, non-owner assignee B, **A's** assignment
    cancelled → owner still cleared to null even though B remains assigned (accepted upstream
    wrinkle — decide deliberately before porting).
36. `[upstream]` User with no Deal write access inserts a direct `ToDo` assignment → throws
    `PermissionError`, owner unchanged.
37. `[upstream]` User **with** Deal write access creates a direct `ToDo` assigning someone else →
    that user becomes the new owner.
38. `[upstream]` A `CRM Task` assignment is cancelled → no Lead/Deal owner field is touched
    (owner concept is Lead/Deal-only).
39. `lead_owner`/`deal_owner` set directly on the doc to a non-assignee user → that user is
    assigned (ToDo created) and shared; any previous owner's share is revoked.

**Status-change log**

40. New Lead/Deal first saved with an initial status → exactly one `status_change_log` row,
    `from`=initial status, `to`="" (open).
41. Existing Lead/Deal status changes A→B → the open row's `to`/`to_type`/`to_date` fill with B
    and now (duration computed), and a new open row appends with `from=B`.

**Deal forecasting fields**

42. `[upstream]` `enable_forecasting=1`: no `expected_deal_value` → `MandatoryError`; value
    present but no `expected_closure_date` → `MandatoryError`; both present → saves.
43. `[upstream]` Status → Won-type → `closed_date` set to today (only if not already set).
44. `auto_update_expected_deal_value=1`, Deal already has a non-zero `expected_deal_value` →
    changing `net_total`/`total` overwrites it to match; a Deal with **no**
    `expected_deal_value` yet is left untouched even with the setting on.

**Permissions / row visibility**

45. Hierarchy disabled, Sales User owns nothing but has one Lead assigned → listing Leads shows
    only that one.
46. Hierarchy enabled, a Sales Manager **in** the tree → sees only own + subtree Deals, not
    every Deal (blanket visibility suspended inside the tree).
47. `[upstream]` User with no Deal-granting role calls `get_deal_contacts` for a Deal they can't
    read → `PermissionError`.
