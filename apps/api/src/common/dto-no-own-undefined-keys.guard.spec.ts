import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { ValidationPipe } from "@nestjs/common";
import { plainToInstance } from "class-transformer";

/**
 * B1224 guard. The api targets ES2023 (define semantics): a DTO property with no `declare` is
 * emitted as an own `undefined` key on every class-transformer instance, and the global pipe
 * (whitelist + forbidNonWhitelisted) rejects an undecorated one as "property X should not exist".
 * Every class exported from a *.dto.ts must therefore instantiate from `{}` with no own
 * undefined key that lacks a validator. Type-only fields must be `declare x?: T;`.
 */
const SRC_ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".dto.ts") || e.name.endsWith(".controller.ts")) out.push(p);
  }
  return out;
}

describe("DTO classes emit no own undefined keys (B1224)", () => {
  it("validating {} with the global pipe options yields no 'should not exist' error", async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    const offenders: string[] = [];
    let classes = 0;
    let controllerDtos = 0;
    for (const file of walk(SRC_ROOT)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(file) as Record<string, unknown>;
      const isController = file.endsWith(".controller.ts");
      for (const [name, exp] of Object.entries(mod)) {
        // Controllers export services-facing classes too: only their exported *Dto classes count.
        if (isController && !/Dto$/.test(name)) continue;
        if (typeof exp !== "function" || !/^class\s/.test(Function.prototype.toString.call(exp)))
          continue;
        classes++;
        if (isController) controllerDtos++;
        const inst = plainToInstance(exp as new () => object, {}) as Record<string, unknown>;
        const own = Object.keys(inst).filter((k) => inst[k] === undefined);
        if (own.length === 0) continue;
        try {
          await pipe.transform({}, { type: "body", metatype: exp as never });
        } catch (e) {
          const msg = JSON.stringify((e as { getResponse?: () => unknown }).getResponse?.());
          for (const k of own)
            if (msg.includes(`property ${k} should not exist`))
              offenders.push(`${path.relative(SRC_ROOT, file)}: ${name}.${k}`);
        }
      }
    }
    expect(classes).toBeGreaterThan(50);
    // Exported *Dto classes declared inside *.controller.ts files (17 on master 39485bc52 when written; floor 16).
    expect(controllerDtos).toBeGreaterThanOrEqual(16);
    expect(offenders).toEqual([]);
  });
});
