import { BadRequestException } from "@nestjs/common";
import { plainToInstance, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsInt,
  IsObject,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
  validateSync,
} from "class-validator";
import type { QuickKeysRegisterSettings } from "@routeflow/types";
import {
  COUNTER_DEFAULT_REGISTER,
  QUICK_KEYS_DEFAULT_CAP,
  QUICK_KEYS_DEFAULT_WINDOW_DAYS,
  QUICK_KEYS_MAX_CAP,
  QUICK_KEYS_MAX_HIDDEN,
  QUICK_KEYS_MAX_WINDOW_DAYS,
  type FilledQuickKeysSettings,
} from "../quick-keys-settings";

/** One register's pins (in pin order) and hides. */
export class QuickKeysRegisterDto implements QuickKeysRegisterSettings {
  @IsArray()
  @ArrayMaxSize(QUICK_KEYS_MAX_CAP)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  pinned!: string[];

  @IsArray()
  @ArrayMaxSize(QUICK_KEYS_MAX_HIDDEN)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  hidden!: string[];
}

export class QuickKeysCounterDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => QuickKeysRegisterDto)
  default!: QuickKeysRegisterDto;

  /** A map of register key -> register settings; each value is validated against QuickKeysRegisterDto below. */
  @ValidateIf((o: QuickKeysCounterDto) => o.registers !== undefined)
  @IsObject()
  registers?: Record<string, unknown>;

  @ValidateIf((o: QuickKeysCounterDto) => o.windowDays !== undefined)
  @IsInt()
  @Min(1)
  @Max(QUICK_KEYS_MAX_WINDOW_DAYS)
  windowDays?: number;

  @ValidateIf((o: QuickKeysCounterDto) => o.cap !== undefined)
  @IsInt()
  @Min(1)
  @Max(QUICK_KEYS_MAX_CAP)
  cap?: number;
}

/** The `quickKeys` value in PATCH /settings. */
export class QuickKeysSettingsDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => QuickKeysCounterDto)
  counter!: QuickKeysCounterDto;
}

export const QUICK_KEYS_INVALID_MESSAGE = "quickKeys is invalid";
export const QUICK_KEYS_OVER_CAP_MESSAGE = "quickKeys pinned exceeds the cap";

/** A register key is a short slug; the prototype-pollution names are refused outright. */
const REGISTER_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_REGISTERS = 20;

const invalid = () => new BadRequestException(QUICK_KEYS_INVALID_MESSAGE);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Whitelist + forbidNonWhitelisted, the strict shape check; true when `dto` has no violation. */
function clean(dto: object): boolean {
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length === 0;
}

/**
 * Validates the `quickKeys` value of PATCH /settings against EXACTLY the contract shape and returns the
 * normalised value that is stored. Pure and synchronous: it checks the shape, the caps and the duplicates;
 * the tenant ownership of the ids is the caller's one query. Every refusal is a 400 with a FIXED message
 * (the input is never echoed). `registers.main` is the default register in v1: it is stored as `default`.
 */
export function validateQuickKeysInput(raw: unknown): FilledQuickKeysSettings {
  if (!isPlainObject(raw)) throw invalid();
  // `@ValidateNested` also accepts arrays, so the three object levels are judged first: an array there is a 400, never
  // a TypeError further down.
  if (!isPlainObject(raw.counter) || !isPlainObject(raw.counter.default)) throw invalid();
  if (raw.counter.registers !== undefined && !isPlainObject(raw.counter.registers)) throw invalid();
  // class-transformer silently drops `__proto__`, so the register keys are judged on the raw input first.
  const rawRegisters = isPlainObject(raw.counter) ? raw.counter.registers : undefined;
  if (isPlainObject(rawRegisters)) {
    for (const key of Object.keys(rawRegisters)) {
      if (FORBIDDEN_KEYS.has(key) || !REGISTER_KEY.test(key)) throw invalid();
    }
  }
  const dto = plainToInstance(QuickKeysSettingsDto, raw);
  if (!clean(dto)) throw invalid();

  const counter = dto.counter;
  const cap = counter.cap ?? QUICK_KEYS_DEFAULT_CAP;
  let def: QuickKeysRegisterSettings = {
    pinned: counter.default.pinned,
    hidden: counter.default.hidden,
  };

  const registers: Record<string, QuickKeysRegisterSettings> = {};
  if (counter.registers !== undefined) {
    const entries = Object.entries(counter.registers);
    if (entries.length > MAX_REGISTERS) throw invalid();
    for (const [key, value] of entries) {
      if (FORBIDDEN_KEYS.has(key) || !REGISTER_KEY.test(key) || !isPlainObject(value)) {
        throw invalid();
      }
      const reg = plainToInstance(QuickKeysRegisterDto, value);
      if (!clean(reg)) throw invalid();
      const parsed = { pinned: reg.pinned, hidden: reg.hidden };
      if (key === COUNTER_DEFAULT_REGISTER) def = parsed;
      else registers[key] = parsed;
    }
  }

  for (const reg of [def, ...Object.values(registers)]) {
    if (reg.pinned.length > cap) throw new BadRequestException(QUICK_KEYS_OVER_CAP_MESSAGE);
  }

  const out: FilledQuickKeysSettings = {
    counter: {
      default: def,
      windowDays: counter.windowDays ?? QUICK_KEYS_DEFAULT_WINDOW_DAYS,
      cap,
    },
  };
  if (Object.keys(registers).length > 0) out.counter.registers = registers;
  return out;
}
