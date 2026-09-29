/**
 * Source scanners shared by the writer tripwires (family-price-writer-tripwire.spec.ts,
 * family-price-override-tripwire.spec.ts). Pure text functions; no fs.
 */
export const WRITE_METHODS = ["create", "update", "upsert", "createMany", "updateMany"];

export function balanced(text: string, openIdx: number): string {
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    i++;
  }
  return text.slice(openIdx, i);
}

export function callBlocks(text: string, receiver: string, methods: string[]): string[] {
  const out: string[] = [];
  for (const method of methods) {
    const needle = `.${receiver}.${method}(`;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      out.push(balanced(text, idx + needle.length - 1));
      from = idx + needle.length;
    }
  }
  return out;
}

export type DataArg = "literal" | "spread" | "opaque" | "none";

export function dataArgKind(block: string): DataArg {
  const m = /(^|[\s{,(])data\b\s*([:,}])/m.exec(block);
  if (!m) return "none";
  if (m[2] !== ":") return "opaque";
  const rest = block.slice(m.index + m[0].length).trimStart();
  if (rest.startsWith("{") || rest.startsWith("[")) {
    const open = rest[0];
    const inner = balancedGeneric(rest, 0, open, open === "{" ? "}" : "]");
    // `...(cond ? { k: v } : {})` spreads a literal built in place; `...dto` / `...rest` spreads a value
    // the scan cannot see into.
    return /\.\.\.\s*[A-Za-z_$]/.test(inner) ? "spread" : "literal";
  }
  return "opaque";
}

export function balancedGeneric(
  text: string,
  openIdx: number,
  open: string,
  close: string,
): string {
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === open) depth++;
    else if (text[i] === close) depth--;
    i++;
  }
  return text.slice(openIdx, i);
}

/** Every product write call block whose data argument is a variable or contains a spread. */
export function opaqueProductWrites(text: string): string[] {
  const out: string[] = [];
  for (const receiver of ["product", "products"]) {
    const methods = receiver === "product" ? WRITE_METHODS : ["create", "update"];
    for (const block of callBlocks(text, receiver, methods)) {
      const kind = dataArgKind(block);
      if (kind === "opaque" || kind === "spread") out.push(block);
    }
  }
  return out;
}

/** Every `data: { ... }` object literal (balanced braces) of a `.product|.products` write call. */
export function productDataLiterals(text: string): string[] {
  const out: string[] = [];
  for (const receiver of ["product", "products"]) {
    for (const call of callBlocks(text, receiver, WRITE_METHODS)) {
      const dataAt = call.search(/\bdata\s*:\s*\{/);
      if (dataAt === -1) continue;
      out.push(balancedGeneric(call, call.indexOf("{", dataAt), "{", "}"));
    }
  }
  return out;
}

/** Every `create: { ... }` / `update: { ... }` object literal of a `.product|.products` upsert. */
export function productUpsertLiterals(text: string): string[] {
  const out: string[] = [];
  for (const receiver of ["product", "products"]) {
    for (const call of callBlocks(text, receiver, ["upsert"])) {
      for (const key of ["create", "update"]) {
        const at = call.search(new RegExp(`\\b${key}\\s*:\\s*\\{`));
        if (at !== -1) out.push(balancedGeneric(call, call.indexOf("{", at), "{", "}"));
      }
    }
  }
  return out;
}

/** Every write-call block on the `.trackedCategory` / `.trackedSubcategory` delegates. */
export function trackedDelegateWrites(text: string): string[] {
  return ["trackedCategory", "trackedSubcategory"].flatMap((r) =>
    callBlocks(text, r, [...WRITE_METHODS, "delete"]),
  );
}
