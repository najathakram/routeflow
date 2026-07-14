# P6-6 — Settings → Notifications matrix + templates (api + web)

## Status

PLANNED — 2026-07-14

## Context

Real Settings → Notifications: the event×channel rules matrix (`NotificationRule` cells), editable `MessageTemplate` bodies with `{{var}}` re-parse + live preview, quiet-hours, and lazy per-tenant seeding of defensible defaults. **NO migration** — NotificationRule/MessageTemplate/MessagingSettings shipped in P6-1. `MessagingService.notify()` already reads `notificationRule.findMany({where:{eventKey, enabled:true}})` + the channel's active template — so a toggled cell gates real sends the moment P6-5's triggers call `notify()`. P6-6 ships the CONFIG it consults.

Verified (re-read before editing):

- **Seeding gap:** nothing creates rule/template rows → a fresh tenant's `notify()` no-ops. P6-6 seeds lazily on first `GET /messaging/config`.
- **G12:** `isInvoicePolicyViolation(eventKey, channel)` at `messaging.helpers.ts:32` (blocks `INVOICE_SENT` on WHATSAPP/SMS); re-enforced at send (`messaging.service.ts:89`). `renderTemplate(body, vars)` at `:48` (`{{var}}` regex, missing → "", pure).
- **Models** (`schema.prisma`): `NotificationRule` :2474 (`enabled Boolean @default(false)`, `@@unique([tenantId,eventKey,channel])`), `MessageTemplate` :2454 (`body`, `variables String[]`, `waTemplateName?`, `waApprovalStatus`, `isActive`, same unique — **no `subject`**), `MessagingSettings` :2510 (`tenantId @unique`, quiet defaults `"21:00"`/`"07:00"`). `enum NotificationEvent` (11 values) :2415; `enum MessageChannel {INTERNAL,WHATSAPP,SMS,EMAIL,PORTAL}` :2387; `enum WaApprovalStatus {NONE,PENDING,APPROVED,REJECTED}`.
- **Controller** `messaging.controller.ts`: class `@UseGuards(JwtAuthGuard,RolesGuard)` + `@Roles(OPERATOR)`; method-level `@Roles(TENANT_ADMIN)` overrides (roles.guard getAllAndOverride, TENANT_ADMIN⊃OPERATOR — the settings/margin pattern). Global ValidationPipe (main.ts:160) — no `@UsePipes`.
- **Module** `messaging.module.ts` imports `EntitlementsModule` (exports `MeterService`). `MeterService.read(tenantId, MeterKey.MSGS): Promise<{used, included:number|null, remaining:number|null, resetsAt:Date|null}>` (billing/meter.service.ts:43).
- **forTenant()** auto-injects tenantId into createMany/upsert.create/where; `createMany skipDuplicates` makes seeding race-safe. prisma-mock registers notificationRule/messageTemplate/messagingSettings + forTenant + `getTenantId()→"test-tenant"`. **`messaging.service.spec.ts` must stay green.**
- **Web** `settings/page.tsx`: Radix Tabs; there's ALREADY a "Notifications" tab (`value="notifications"`, trigger ~:3068, content ~:3106) rendering a DUMMY `NotificationsTab` (:389, hardcoded driver-push checkboxes). P6-6 replaces its body (keep the real push-status card + test button; delete the fake checkbox list). Hooks pattern: `lib/api/margin.ts`; admin gate `CostingTab` (`useAuth`→isAdmin). No Switch in `@routeflow/ui/web` — use the `MerchFlagToggle` inline `role="switch"` idiom.

Constraints: no migration; no money logic (`{{amount}}` vars are pre-formatted strings from P6-5 callers); `waApprovalStatus` display-only (P6-3/4 own it); Conventional Commits; `npm run verify`.

## Acceptance

1. `GET /messaging/config` (OPERATOR) returns `{events:[{eventKey,label,channels:[{channel,enabled,ruleId,locked,template}]}], settings, msgsMeter}` and lazily seeds all missing pairs idempotently. Defaults ON: OUT_FOR_DELIVERY→PORTAL, DELIVERED→PORTAL, INVOICE_SENT→EMAIL, the 4 INTERNAL alerts.
2. `PATCH /messaging/rules/:id {enabled}` (TENANT_ADMIN) persists a cell; enabling a G12 pair (INVOICE_SENT×WA/SMS) → 400; those cells render locked (never seeded).
3. `PATCH /messaging/templates/:id` (TENANT_ADMIN) edits body/waTemplateName/isActive; body edit re-parses `{{vars}}` into `variables[]`. `POST /messaging/templates/preview` renders via the same `renderTemplate`.
4. `GET/PATCH /messaging/settings` round-trip quiet hours (PATCH admin, create-on-first-save upsert).
5. Web Notifications tab: live matrix with per-cell switches (admin-gated, optimistic), locked invoice cells (lock+tooltip), WA cells showing `waApprovalStatus` chip, template editor (live var re-parse + server preview), quiet-hours mini-form, MSGS meter line; existing push-status card retained.
6. Jest passes incl. new `messaging-config.service.spec.ts`; `messaging.service.spec.ts` untouched + green.

## Work Packages

### WP1 — api: MessagingConfigService (consts + lazy seed + matrix/rule/template/settings ops) + extractVariables + spec

files:

- `apps/api/src/messaging/messaging.helpers.ts` (edit — add `extractVariables`)
- `apps/api/src/messaging/messaging-config.service.ts` (new)
- `apps/api/src/messaging/messaging.module.ts` (edit — register + export)
- `apps/api/src/messaging/messaging-config.service.spec.ts` (new)

**1a. `messaging.helpers.ts` — append:**

```ts
/**
 * Distinct `{{var}}` names in a body, first-appearance order — same grammar as
 * renderTemplate. Pure. P6-6 re-derives MessageTemplate.variables on every edit
 * + at seed time; P6-5 reads the consts below for the vars each trigger passes.
 */
export function extractVariables(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
```

**1b. `messaging-config.service.ts` (new, FULL exact code):**

```ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { MessageChannel, MeterKey, NotificationEvent, WaApprovalStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { extractVariables, isInvoicePolicyViolation, renderTemplate } from "./messaging.helpers";

const { INTERNAL, WHATSAPP, SMS, EMAIL, PORTAL } = MessageChannel;
const CUSTOMER_CHANNELS: MessageChannel[] = [WHATSAPP, SMS, EMAIL, PORTAL];

/** Channels each event supports — single source of truth for the matrix (P6-6)
 *  AND P6-5's triggers. INVOICE_SENT omits WA/SMS (G12); ops alerts are INTERNAL-only. */
export const EVENT_CHANNELS: Record<NotificationEvent, MessageChannel[]> = {
  [NotificationEvent.ORDER_CONFIRMED]: CUSTOMER_CHANNELS,
  [NotificationEvent.OUT_FOR_DELIVERY]: CUSTOMER_CHANNELS,
  [NotificationEvent.DELIVERED]: CUSTOMER_CHANNELS,
  [NotificationEvent.ORDER_CHANGED_AT_DOOR]: CUSTOMER_CHANNELS,
  [NotificationEvent.INVOICE_SENT]: [EMAIL, PORTAL],
  [NotificationEvent.PAYMENT_REMINDER]: CUSTOMER_CHANNELS,
  [NotificationEvent.LICENSE_EXPIRING]: CUSTOMER_CHANNELS,
  [NotificationEvent.URGENT_ORDER_PLACED]: [INTERNAL],
  [NotificationEvent.LOW_STOCK]: [INTERNAL],
  [NotificationEvent.FAILED_DELIVERY]: [INTERNAL],
  [NotificationEvent.PAYMENT_FAILED_NSF]: [INTERNAL],
};

/** Friendly label + starter body per event; `variables` derived from the body
 *  via extractVariables at seed time. Money-looking vars are PRE-FORMATTED
 *  STRINGS supplied by P6-5 callers — no money math in messaging. */
export const DEFAULT_TEMPLATES: Record<NotificationEvent, { label: string; body: string }> = {
  [NotificationEvent.ORDER_CONFIRMED]: {
    label: "Order confirmed",
    body: "Hi {{customerName}}, your order {{orderNumber}} is confirmed for delivery on {{deliveryDate}}. Total: {{orderTotal}}.",
  },
  [NotificationEvent.OUT_FOR_DELIVERY]: {
    label: "Out for delivery",
    body: "Hi {{customerName}}, your order {{orderNumber}} is out for delivery today with {{driverName}}.",
  },
  [NotificationEvent.DELIVERED]: {
    label: "Delivered",
    body: "Hi {{customerName}}, order {{orderNumber}} was delivered. Total: {{orderTotal}}. Thank you!",
  },
  [NotificationEvent.ORDER_CHANGED_AT_DOOR]: {
    label: "Order changed at door",
    body: "Hi {{customerName}}, order {{orderNumber}} was adjusted at delivery: {{changeSummary}}. New total: {{orderTotal}}.",
  },
  [NotificationEvent.INVOICE_SENT]: {
    label: "Invoice sent",
    body: "Hi {{customerName}}, invoice {{invoiceNumber}} for {{invoiceTotal}} is ready. Due {{dueDate}}.",
  },
  [NotificationEvent.PAYMENT_REMINDER]: {
    label: "Payment reminder",
    body: "Hi {{customerName}}, a friendly reminder that invoice {{invoiceNumber}} ({{amountDue}}) is due {{dueDate}}.",
  },
  [NotificationEvent.LICENSE_EXPIRING]: {
    label: "License expiring",
    body: "Hi {{customerName}}, our records show your license expires on {{expiryDate}}. Please send us an updated copy.",
  },
  [NotificationEvent.URGENT_ORDER_PLACED]: {
    label: "Urgent order placed",
    body: "Urgent order {{orderNumber}} from {{customerName}} needs review.",
  },
  [NotificationEvent.LOW_STOCK]: {
    label: "Low stock",
    body: "Low stock: {{productName}} is down to {{quantity}} left.",
  },
  [NotificationEvent.FAILED_DELIVERY]: {
    label: "Failed delivery",
    body: "Delivery failed for order {{orderNumber}} ({{customerName}}): {{reason}}.",
  },
  [NotificationEvent.PAYMENT_FAILED_NSF]: {
    label: "Payment failed (NSF)",
    body: "Check payment from {{customerName}} for {{amount}} was returned NSF on invoice {{invoiceNumber}}.",
  },
};

/** Cells seeded enabled=true — PORTAL/EMAIL (free, un-metered, consent-less) +
 *  the internal alerts. Every metered/consented channel (WA/SMS) seeds OFF. */
export const DEFAULT_ON = new Set<string>([
  `${NotificationEvent.OUT_FOR_DELIVERY}:${PORTAL}`,
  `${NotificationEvent.DELIVERED}:${PORTAL}`,
  `${NotificationEvent.INVOICE_SENT}:${EMAIL}`,
  `${NotificationEvent.URGENT_ORDER_PLACED}:${INTERNAL}`,
  `${NotificationEvent.LOW_STOCK}:${INTERNAL}`,
  `${NotificationEvent.FAILED_DELIVERY}:${INTERNAL}`,
  `${NotificationEvent.PAYMENT_FAILED_NSF}:${INTERNAL}`,
]);

export interface TemplateView {
  id: string;
  body: string;
  variables: string[];
  waTemplateName: string | null;
  waApprovalStatus: WaApprovalStatus;
  isActive: boolean;
}
export interface MatrixCell {
  channel: MessageChannel;
  enabled: boolean;
  ruleId: string | null;
  locked: boolean;
  template: TemplateView | null;
}
export interface MatrixEvent {
  eventKey: NotificationEvent;
  label: string;
  channels: MatrixCell[];
}
export interface MessagingSettingsView {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string | null;
}
export interface MessagingConfigView {
  events: MatrixEvent[];
  settings: MessagingSettingsView;
  msgsMeter: {
    used: number;
    included: number | null;
    remaining: number | null;
    resetsAt: string | null;
  } | null;
}

@Injectable()
export class MessagingConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meter: MeterService,
  ) {}

  async getMatrix(): Promise<MessagingConfigView> {
    const tenantId = this.requireTenant();
    const db = this.prisma.forTenant();
    let [rules, templates] = await Promise.all([
      db.notificationRule.findMany({}),
      db.messageTemplate.findMany({}),
    ]);
    const seeded = await this.seedMissing(db, rules, templates);
    if (seeded)
      [rules, templates] = await Promise.all([
        db.notificationRule.findMany({}),
        db.messageTemplate.findMany({}),
      ]);

    const ruleBy = new Map(rules.map((r) => [`${r.eventKey}:${r.channel}`, r]));
    const tplBy = new Map(templates.map((t) => [`${t.eventKey}:${t.channel}`, t]));

    const events: MatrixEvent[] = (Object.keys(EVENT_CHANNELS) as NotificationEvent[]).map(
      (eventKey) => {
        const channels: MatrixCell[] = EVENT_CHANNELS[eventKey].map((channel) => {
          const rule = ruleBy.get(`${eventKey}:${channel}`);
          const tpl = tplBy.get(`${eventKey}:${channel}`);
          return {
            channel,
            enabled: rule?.enabled ?? false,
            ruleId: rule?.id ?? null,
            locked: false,
            template: tpl ? this.templateView(tpl) : null,
          };
        });
        for (const channel of [WHATSAPP, SMS]) {
          if (isInvoicePolicyViolation(eventKey, channel))
            channels.push({ channel, enabled: false, ruleId: null, locked: true, template: null });
        }
        return { eventKey, label: DEFAULT_TEMPLATES[eventKey].label, channels };
      },
    );

    const settings = await this.getSettings();
    let msgsMeter: MessagingConfigView["msgsMeter"] = null;
    try {
      const r = await this.meter.read(tenantId, MeterKey.MSGS);
      msgsMeter = {
        used: r.used,
        included: r.included,
        remaining: r.remaining,
        resetsAt: r.resetsAt ? r.resetsAt.toISOString() : null,
      };
    } catch {
      /* meter readout is decorative — never fail the matrix for it */
    }
    return { events, settings, msgsMeter };
  }

  async setRuleEnabled(id: string, enabled: boolean) {
    const db = this.prisma.forTenant();
    const rule = await db.notificationRule.findFirst({ where: { id } });
    if (!rule) throw new NotFoundException("Notification rule not found");
    if (enabled && isInvoicePolicyViolation(rule.eventKey, rule.channel))
      throw new BadRequestException("Invoices cannot be sent over WhatsApp/SMS");
    const updated = await db.notificationRule.update({ where: { id }, data: { enabled } });
    return {
      id: updated.id,
      eventKey: updated.eventKey,
      channel: updated.channel,
      enabled: updated.enabled,
    };
  }

  async updateTemplate(
    id: string,
    dto: { body?: string; waTemplateName?: string; isActive?: boolean },
  ): Promise<TemplateView> {
    const db = this.prisma.forTenant();
    const existing = await db.messageTemplate.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException("Message template not found");
    const data: Record<string, unknown> = {};
    if (dto.body !== undefined) {
      data.body = dto.body;
      data.variables = extractVariables(dto.body);
    }
    if (dto.waTemplateName !== undefined)
      data.waTemplateName = dto.waTemplateName === "" ? null : dto.waTemplateName;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const updated = await db.messageTemplate.update({ where: { id }, data });
    return this.templateView(updated);
  }

  preview(body: string, vars: Record<string, string | number> = {}) {
    return { rendered: renderTemplate(body, vars), variables: extractVariables(body) };
  }

  async getSettings(): Promise<MessagingSettingsView> {
    const tenantId = this.requireTenant();
    const row = await this.prisma.forTenant().messagingSettings.findUnique({ where: { tenantId } });
    return {
      quietHoursEnabled: row?.quietHoursEnabled ?? true,
      quietHoursStart: row?.quietHoursStart ?? "21:00",
      quietHoursEnd: row?.quietHoursEnd ?? "07:00",
      timezone: row?.timezone ?? null,
    };
  }

  async updateSettings(dto: {
    quietHoursEnabled?: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    timezone?: string;
  }): Promise<MessagingSettingsView> {
    const tenantId = this.requireTenant();
    const data: Record<string, unknown> = {};
    if (dto.quietHoursEnabled !== undefined) data.quietHoursEnabled = dto.quietHoursEnabled;
    if (dto.quietHoursStart !== undefined) data.quietHoursStart = dto.quietHoursStart;
    if (dto.quietHoursEnd !== undefined) data.quietHoursEnd = dto.quietHoursEnd;
    if (dto.timezone !== undefined) data.timezone = dto.timezone === "" ? null : dto.timezone;
    await this.prisma.forTenant().messagingSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    return this.getSettings();
  }

  private async seedMissing(
    db: PrismaService,
    rules: Array<{ eventKey: NotificationEvent; channel: MessageChannel }>,
    templates: Array<{ eventKey: NotificationEvent; channel: MessageChannel }>,
  ): Promise<boolean> {
    const haveRule = new Set(rules.map((r) => `${r.eventKey}:${r.channel}`));
    const haveTpl = new Set(templates.map((t) => `${t.eventKey}:${t.channel}`));
    const ruleData: Array<{
      eventKey: NotificationEvent;
      channel: MessageChannel;
      enabled: boolean;
    }> = [];
    const tplData: Array<{
      eventKey: NotificationEvent;
      channel: MessageChannel;
      body: string;
      variables: string[];
      isActive: boolean;
    }> = [];
    for (const eventKey of Object.keys(EVENT_CHANNELS) as NotificationEvent[]) {
      for (const channel of EVENT_CHANNELS[eventKey]) {
        const key = `${eventKey}:${channel}`;
        if (!haveRule.has(key)) ruleData.push({ eventKey, channel, enabled: DEFAULT_ON.has(key) });
        if (!haveTpl.has(key))
          tplData.push({
            eventKey,
            channel,
            body: DEFAULT_TEMPLATES[eventKey].body,
            variables: extractVariables(DEFAULT_TEMPLATES[eventKey].body),
            isActive: true,
          });
      }
    }
    if (ruleData.length === 0 && tplData.length === 0) return false;
    if (ruleData.length > 0)
      await db.notificationRule.createMany({ data: ruleData, skipDuplicates: true });
    if (tplData.length > 0)
      await db.messageTemplate.createMany({ data: tplData, skipDuplicates: true });
    return true;
  }

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("Tenant context required");
    return tenantId;
  }

  private templateView(t: {
    id: string;
    body: string;
    variables: string[];
    waTemplateName: string | null;
    waApprovalStatus: WaApprovalStatus;
    isActive: boolean;
  }): TemplateView {
    return {
      id: t.id,
      body: t.body,
      variables: t.variables,
      waTemplateName: t.waTemplateName,
      waApprovalStatus: t.waApprovalStatus,
      isActive: t.isActive,
    };
  }
}
```

**1c. `messaging.module.ts`** — add `MessagingConfigService` to `providers` + `exports` (import it); keep `imports:[EntitlementsModule]`, `MESSAGE_PROVIDER→StubProvider`.

**1d. `messaging-config.service.spec.ts` (new)** — build `ALL_PAIRS` from EVENT_CHANNELS; cover: **seeding** — first read (findMany []→seeded) calls `createMany({skipDuplicates:true})` for both models with `ALL_PAIRS.length` rows, exactly `DEFAULT_ON.size` enabled, INVOICE_SENT seeds only EMAIL+PORTAL and the matrix shows WHATSAPP+SMS `locked`; **idempotent** — fully-seeded tenant → no createMany, findMany called once; **cell shape** — LOW_STOCK 1 INTERNAL cell enabled+ruleId+template.variables `["productName","quantity"]`, settings defaults, msgsMeter shape; **meter throws → null meter, matrix still returned**; **setRuleEnabled** — toggle updates, 404 unknown, refuse-enable G12 (BadRequest, no update) but allow disable; **updateTemplate** — body edit re-parses vars + `""`→null waTemplateName, 404 unknown; **preview** — missing var→"" + returns parsed vars; **settings** — defaults when null, upsert create-on-first-save with only provided keys; + `extractVariables` distinct/order/whitespace/dotted. Use `createMockPrisma()` + mock `MeterService`. (Full spec bodies as authored — implement verbatim.)

### WP2 — api: controller endpoints + DTOs (reads OPERATOR, writes TENANT_ADMIN)

files:

- `apps/api/src/messaging/dto/update-rule.dto.ts` (new — `{ @IsBoolean enabled }`)
- `apps/api/src/messaging/dto/update-template.dto.ts` (new — `body? @IsString @MaxLength(2000)`, `waTemplateName? @MaxLength(200)`, `isActive? @IsBoolean`, all @IsOptional)
- `apps/api/src/messaging/dto/preview-template.dto.ts` (new — `body @IsString @MaxLength(2000)`, `vars? @IsOptional @IsObject`)
- `apps/api/src/messaging/dto/update-messaging-settings.dto.ts` (new — `quietHoursEnabled? @IsBoolean`, `quietHoursStart?/quietHoursEnd? @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)`, `timezone? @IsString @MaxLength(64)`, all @IsOptional)
- `apps/api/src/messaging/messaging.controller.ts` (edit)

brief: inject `MessagingConfigService`; add `GET /messaging/config` (OPERATOR, seeds on read), `PATCH /messaging/rules/:id` (@Roles TENANT_ADMIN), `PATCH /messaging/templates/:id` (TENANT_ADMIN), `POST /messaging/templates/preview` (@HttpCode 200), `GET /messaging/settings` (OPERATOR), `PATCH /messaging/settings` (TENANT_ADMIN). Global ValidationPipe validates the DTOs. Exact endpoint code in the authored plan; no route collisions; no controller spec exists.

### WP3 — web: `lib/api/messaging.ts` hooks + types (new)

files:

- `apps/web/lib/api/messaging.ts` (new)

brief: FULL exact code — types (`MessageChannel`/`WaApprovalStatus`/`MessageTemplateInfo`/`MatrixCell`/`MatrixEvent`/`MessagingSettings`/`MsgsMeter`/`MessagingConfig`); `useMessagingConfig` (`["messaging-config"]`, GET /messaging/config); `useToggleRule` (PATCH /messaging/rules/:id, **optimistic** onMutate cell flip + rollback + settled invalidate); `useUpdateTemplate` (PATCH /messaging/templates/:id, invalidate); `usePreviewTemplate` (POST /messaging/templates/preview); `useUpdateMessagingSettings` (PATCH /messaging/settings); `extractTemplateVars(body)` (client mirror of the `{{var}}` parser — use a `matchAll` or `regex.exec` loop). Mirror `lib/api/margin.ts` style. (Full file in the authored plan.)

### WP4 — web: NotificationsTab rewrite — detailed brief (anchors)

files:

- `apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx` (new)
- `apps/web/app/(dashboard)/settings/page.tsx` (edit)

brief: `page.tsx` — DELETE the dummy `NotificationsTab` (lines ~387-488) + its now-unused `useNotificationsStatus/useSendTestNotification` import (:67, keep `Bell`); import `NotificationsSettingsTab` from `./_components/` (next to RegulatedSettingsTab :82); change the notifications `Tabs.Content` (~:3106) to `max-w-4xl` mounting `<NotificationsSettingsTab />`. New `_components/NotificationsSettingsTab.tsx` (RegulatedSettingsTab extraction pattern): `useAuth`→isAdmin; `useMessagingConfig` (loading spinner / error). Sections: (1) **matrix Card** — table rows=events (label + a Pencil→template modal), columns=`["INTERNAL","WHATSAPP","SMS","EMAIL","PORTAL"]`; per cell: not-applicable→muted `—`, `locked`→`Lock` icon + tooltip "Invoices can't be sent over WhatsApp or SMS", else a `MiniSwitch` (`role="switch"` copy of MerchFlagToggle, `disabled={!isAdmin||toggle.isPending}`) → `useToggleRule.mutate({ruleId, enabled:!enabled})` (optimistic); WHATSAPP cells also render a `waApprovalStatus` Badge under the switch; MSGS meter line in the header; admins-only note. (2) **template editor Modal** (per event) — channel pills (non-locked cells), Textarea body (`disabled={!isAdmin}`), a live "Variables" chip row from `extractTemplateVars(body)` re-parsed every keystroke (chips insert `{{var}}`), a debounced (400ms) server `usePreviewTemplate` panel with SAMPLE_VARS, WHATSAPP → a "Meta template name" Input + approval Badge + hint, an `isActive` MiniSwitch, Save (admin) → `useUpdateTemplate`. (3) **quiet-hours Card** — MiniSwitch + two `<input type=time>` (disabled unless admin+enabled), Save → `useUpdateMessagingSettings` (no timezone field). (4) **push-status Card** — copy the KEPT parts of the old tab (device status + "Send test" via `useSendTestNotification`); delete the fake checkbox list. Every icon-only button gets `aria-label`; run lint for unused imports.

### WP5 — code-map + verify

files: `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/_meta.json`

brief: api.md messaging section → `MessagingConfigService` (EVENT_CHANNELS/DEFAULT_TEMPLATES/DEFAULT_ON single source of truth shared with P6-5; getMatrix lazy-seeds via createMany skipDuplicates; G12 never-seeded + refuse-enable; updateTemplate re-parses {{vars}} via new `extractVariables`; preview reuses renderTemplate; settings upsert) + the 6 endpoints (writes @Roles TENANT_ADMIN). web.md → real Notifications tab (`_components/NotificationsSettingsTab.tsx` matrix + template editor + quiet hours + kept push card) over `lib/api/messaging.ts` (`["messaging-config"]`, optimistic toggle, preview, client extractTemplateVars). Bump \_meta generatedAt + prepend a P6-6 note. `npm run verify`.

### Assumptions to double-check

1. G12 helper `isInvoicePolicyViolation` at messaging.helpers.ts:32 (INVOICE_EVENTS={INVOICE_SENT}); re-checked at send.
2. `MeterService.read(tenantId, MeterKey): Promise<{used,included,remaining,resetsAt}>` reachable via EntitlementsModule (already imported).
3. Keep the genuine push-status card; delete only the persist-nothing checkbox list.
4. `waApprovalStatus` display-only (P6-3 owns transitions); enabling a WA cell is allowed regardless (StubProvider needs no approval).
5. Method `@Roles(TENANT_ADMIN)` overrides class OPERATOR (settings/margin pattern).
6. No `messaging.controller.spec.ts` — new dep breaks no DI. `messaging.service.spec.ts` untouched.
7. `matchAll` needs es2020+ lib — API is fine; if web lint objects, swap `extractTemplateVars` to a `regex.exec` loop.

### Critical Files

- apps/api/src/messaging/messaging-config.service.ts (new — the heart)
- apps/api/src/messaging/messaging.controller.ts
- apps/api/src/messaging/messaging.helpers.ts
- apps/web/lib/api/messaging.ts (new)
- apps/web/app/(dashboard)/settings/page.tsx
