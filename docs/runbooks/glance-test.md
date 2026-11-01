# Glance test (marketing site)

The owner's rule (2026-10-31, ruling SA-1075 A-2): **the site is understood in a second, by simply
looking at it, even by a second-language reader.** The words are in `rf-specs`
`specs/website-review/COPY.md` section 0. This runbook is the third layer of its "glance gate".
The first layer is the static guard `apps/web/app/(marketing)/marketing-one-look.static.test.ts`;
the second is the word grader. Nobody runs the glance test on their own words.

## When

On every piece that changes a headline or a hero picture of a marketing page (W0, W4, W7 and the
later hero changes).

## Take the shots

Start the site (`npm run dev -w apps/web` serves `:3001`; the home page needs no API or database)
and run:

```bash
node apps/web/scripts/glance-shots.mjs --piece w0
```

It shoots the first screen at 1440 and at 390 wide and writes
`local-assets/proofs/website-review/<piece>/<piece>-desktop-1440.png` and `...-phone-390.png`.
Those files are gitignored; never commit them. Options: `--url`, `--path` (default `/`), `--brand`
(the made-up name, default `Northbay`), `--out`.

Before the shot the script, so the picture has to carry the meaning alone:

- blurs text under 20 px by 6 px (nobody reads it in a second);
- swaps the product name for the made-up one and hides the logo;
- turns motion off, takes the shot at first paint, and clicks nothing.

## Readers

Five fresh readers per view set: three on the desktop shot, two on the phone shot. Each is an agent
playing a wholesale owner who reads English at B1, with a first language taken from a rota, shown
**one image and nothing else**. Ask three things: what is this, who is it for, what would you click
next, and how sure are you.

A separate agent scores the answers against a key written **first**:

- **What:** software for orders and delivery, not a delivery company.
- **Who:** wholesale businesses. "Small business" alone fails.
- **Next:** the label of the filled button, named in the key for that view.

**Pass:** at least 4 of 5 get all three, and at least 4 of 5 are sure.

A word that 2 or more readers stop on in one view goes in COPY.md section 7 and on the banned list in
`marketing-one-look.static.test.ts`, or stays with a written reason.

For sections below the hero, use a headline sheet instead: 2 readers plus the grader, with the key
holding the lines themselves so a wrong reading can be scored.

## What it cannot prove

Agents read English well and stand in for real people, so a pass is a floor, not a measurement.
"Words stopped on" is a question they are asked, so it runs high: compare wordings against each
other. The owner's own eyes on a real second-language reader count for more than this table.
