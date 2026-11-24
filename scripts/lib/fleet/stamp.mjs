// UTC stamp: YYYY-MM-DDTHH:MMZ (--seconds adds :SS). Never reads the local time zone.
export function stamp({ now = new Date(), seconds = false } = {}) {
  const iso = now.toISOString(); // always UTC
  return seconds ? `${iso.slice(0, 19)}Z` : `${iso.slice(0, 16)}Z`;
}

export function run(args, ctx = {}) {
  return { code: 0, lines: [stamp({ now: ctx.now, seconds: args.includes("--seconds") })] };
}
