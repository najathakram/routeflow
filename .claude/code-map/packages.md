# Area: packages (`packages/*`)

Shared workspace packages (types, UI, configs) consumed by apps via npm workspaces.

## Where to find (this area)

| Need                                             | File → symbol                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| Enums (UserRole, OrderStatus, ...)               | `packages/types/index.ts` → `export enum X`                                |
| Type interfaces (User, Order, PaginatedResponse) | `packages/types/index.ts` → `export interface X`                           |
| Web components (Button, Table, Modal, ...)       | `packages/ui/src/web/` → `index.ts` barrel                                 |
| Mobile RN components                             | `packages/ui/src/mobile/index.ts`                                          |
| iOS-specific components                          | `packages/ui/src/mobile/ios/index.ts`                                      |
| Design tokens (colors, spacing, fonts)           | `packages/ui/src/tokens.ts`                                                |
| ESLint flat presets                              | `packages/eslint-config/` → base.js, next.js, react-internal.js            |
| TypeScript presets                               | `packages/typescript-config/` → base.json, nextjs.json, react-library.json |

## Packages

### `@routeflow/types` (`packages/types`)

Shared DTO/enum definitions. Entry: `index.ts` (no `src/`).

- **Enums** (synced with Prisma): `UserRole`, `UserStatus`; `OrderStatus`, `ItemStatus`;
  `RouteRunStatus`, `RouteRunStopStatus`; `TxnStatus`, `PaymentMethod`; `MutationType`,
  `FulfillPath`, `DriverStatus`.
- **Interfaces**: `User`, `Order`, `PaginatedResponse<T>` (data + meta: total/page/limit/totalPages),
  `ApiResponse<T>`.

### `@routeflow/ui` (`packages/ui`)

Cross-platform components. Entry `index.tsx`; subpaths `./web`, `./mobile`, `./tokens`.

- **Web** (`src/web/`, Tailwind + Radix): `Button`, `Input`, `PasswordInput`, `Textarea`,
  `Select`, `Modal`, `Table`, `Avatar`, `Card`, `Badge` (BadgeStatus now covers 30+ statuses
  incl. all finance/returns/estimate/invoice values), `PageHeader`, `EmptyState`, `Toast`
  (ToastProvider/useToast), `StatCard`, `Tabs` (underline tab bar, key+label+badge);
  utils `cn()`, `mergeRefs()`; illustration set.
- **Mobile** (`src/mobile/index.ts`): `MobileButton`, `MobileInput`, `StatusBadge`,
  `ScreenHeader`, `SectionHeader`, `EmptyState`.
- **iOS** (`src/mobile/ios/`): `NavBar`, `NavBackButton`, `NavAction`, `IosTabBar`, `KpiCard`,
  `BrandGradientCard`, `StopCard`, `ExceptionCard`, `SegmentedControl`, `Pill`, `SearchBar`,
  `ListGroup`, `ListRow`, `InlineStats`, `FilterChipRow`, `ProgressTrack`, `GoogleButton`,
  `Blur`, `BrandGlyph`, `MessageBubble`, `IosEmptyState`.
- **Tokens** (`src/tokens.ts`): `colors` (brand 50–900, canvas, navy, success/warning/danger,
  surface), `fontFamily` (Inter), `borderRadius`; typography in `src/typography.ts`.

### `@routeflow/config` (`packages/config`)

Shared build/format configs (no TS source). Exports via package.json: `./eslint`, `./prettier`,
`./tsconfig` (tsconfig.base.json), `./tailwind` (tailwind.config.ts).

### `@routeflow/eslint-config` (`packages/eslint-config`)

Flat ESLint configs (ESM). Exports: `./base` (recommended + turbo + typescript-eslint),
`./next-js`, `./react-internal`. Imported as `@routeflow/eslint-config/base` into workspace configs.

### `@routeflow/typescript-config` (`packages/typescript-config`)

TS config presets (JSON inheritance): `base.json` (es2022, strict, nodeNext), `nextjs.json`
(ESNext, Bundler, noEmit, jsx preserve), `react-library.json` (jsx react-jsx). Used via
`extends` in app `tsconfig.json`.
