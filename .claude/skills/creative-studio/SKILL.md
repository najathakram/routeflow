---
name: creative-studio
metadata:
  version: 1.0.1
description: >
  The front door and conductor for Najath's creative skill suite: copywriting,
  higgsfield-seedance-prompt, maznah-vlog-script, higgsfield-content-factory, and
  motion-design. Use this skill whenever a request is creative or marketing related but
  ambiguous about which skill applies, spans more than one skill, or is campaign-level.
  Trigger on phrases like "full campaign", "launch content for X", "everything for the
  Istanbul video", "content for Pixel Parchment", "make videos and captions", "what can
  you create for me", "which skill should handle this", or any request mixing copy, video,
  narration, and scheduling. Also use it when unsure whether a video request means a
  Seedance prompt, a motion design piece, or a content-factory batch. For a request that
  clearly matches exactly one skill, go to that skill directly; this router is for
  ambiguity, combinations, and end-to-end pipelines.
---

# Creative Studio Router

One entry point for the creative suite. This skill decides which specialist skill leads,
chains skills into pipelines, and enforces the rules that apply across all of them.

## How invocation works

Skills are instructions, not functions. To "call" a skill, read its SKILL.md and follow it.
Read only what the current task needs. One skill leads at a time; the router hands
artifacts between them.

Platform note: the paths below are claude.ai locations. In Claude Code, invoke each skill
by name with the Skill tool, or read it from `.claude/skills/<name>/SKILL.md` (project) or
`~/.claude/skills/<name>/SKILL.md` (personal). Wherever a rule below cites an absolute
`/mnt/skills/user/...` path, resolve it to the platform's location for that skill.

If a skill cannot be found in any location (uninstalled or renamed), say so plainly,
proceed with best effort, and suggest reinstalling.

## The suite

| Skill | Path | Input it expects | Output it produces |
|---|---|---|---|
| copywriting | `/mnt/skills/user/copywriting/SKILL.md` | Brief (or enough context to build one) | Persuasive text: pages, emails, sequences, ads, captions, proposals, plus headline and CTA alternatives |
| higgsfield-seedance-prompt | `/mnt/skills/user/higgsfield-seedance-prompt/SKILL.md` | An idea, script beat, or scene plus any reference assets | ONE standalone Seedance 2.0 prompt in a code block |
| maznah-vlog-script | `/mnt/skills/user/maznah-vlog-script/SKILL.md` | Rough notes, a draft, or a destination plus context | Final narration text only, 9.5/10 gated, nothing else |
| higgsfield-content-factory | `/mnt/skills/user/higgsfield-content-factory/SKILL.md` | Product image or URL plus onboarding answers | 5-stage campaign: research, HTML plan, video batches plus image pack, Meta scheduling, cost report |
| motion-design | `/mnt/skills/user/motion-design/SKILL.md` | Logo, product image, or nothing (it can generate a base visual) | One motion design video via Higgsfield (storyboard then animation) |

## Routing rules

Route by the deliverable, not by the words used.

1. **Any persuasive or marketing text** (page, email, sequence, ad, caption, proposal,
   bio, review response, "humanize this") leads with **copywriting**.
2. **"Make a video" disambiguation**, the most common collision:
   - One cinematic shot or scene from an idea or script beat: **higgsfield-seedance-prompt**
     (output is a prompt, not a rendered video; say so if the user expects a render).
   - Logo reveal, brand promo, animate this image or product into a single polished clip:
     **motion-design** (it renders end to end via Higgsfield).
   - A volume of product content (UGC batches, multi-format, scheduling): 
     **higgsfield-content-factory**.
   - Never stack seedance-prompt on top of motion-design; motion-design owns its own
     prompting internally.
3. **Anything Maznah's channel narration**: **maznah-vlog-script**, always. Do not write
   channel narration through copywriting; the vlog pipeline owns that voice and its own
   quality gate.
4. **Ambiguous or mixed requests**: pick the pipeline below that fits, confirm the plan in
   one short message (or one button question), then run stage by stage.
5. If the request is business operations rather than creative production (CRM, invoices,
   pipeline reviews), hand off to the small-business plugin's own router instead.

## Pipelines

Each stage names the leading skill and the artifact it hands forward. Confirm at stage
boundaries unless the user asked for end to end.

### Pipeline A: Product campaign end to end
For: "run a full campaign for [product]", Aeshal or Filamour drops, client products.
1. **copywriting** builds the brief: audience, offer, proof inventory, the six conviction
   questions. Artifact: the locked brief.
2. **higgsfield-content-factory** runs its five stages using the brief as product context
   (its own onboarding still runs; pre-fill answers from the brief where possible).
   Artifacts: content plan, videos, image pack, Meta schedule, cost report.
3. **copywriting** writes or rewrites all user-facing text the campaign needs beyond the
   factory's hooks: ad primary text, captions, landing page. Artifact: audited copy pack.
4. Optional: **motion-design** for a brand sting or logo piece to cap the campaign.

### Pipeline B: Maznah episode kit
For: "everything for the [destination] video."
1. **maznah-vlog-script** produces the narration. Artifact: final narration text.
2. **higgsfield-seedance-prompt** turns specific beats the couple could not film into
   b-roll prompts, one prompt per shot, on request. Artifact: prompt set.
3. **copywriting** writes the YouTube title options, description, and pinned comment,
   matching the channel's warmth (love, time, invitation) and never contradicting the
   narration. Artifact: publish pack.

### Pipeline C: Brand launch
For: new brand or service going live.
1. **copywriting**: positioning, homepage or landing page, launch emails.
2. **motion-design**: logo reveal or launch promo.
3. **higgsfield-content-factory**: the social content batch, scheduled.

### Pipeline D: Single asset, fast
Any request that fits one skill cleanly: route directly, no ceremony, no pipeline talk.

## Cross-cutting rules (apply in every pipeline)

1. **Universal text audit.** Every user-facing piece of text produced by ANY skill in the
   suite (captions, hooks, ad text, titles, descriptions, on-screen text) passes the
   three-pass audit in `/mnt/skills/user/copywriting/references/ai-style-avoidance.md`
   before delivery. Exception: Maznah narration, which is governed by its own pipeline and
   9.5/10 gate; do not reprocess it.
2. **Sales doctrine scope.** `/mnt/skills/user/copywriting/references/sales-doctrine.md`
   binds all persuasive assets. It does not apply to channel narration, which invites
   rather than sells.
3. **House style everywhere.** No em dashes or en dashes in any deliverable from any
   skill. ESL-accessible language. Direct, solution-forward, human-sounding.
4. **No fabrication anywhere.** Proof, stats, reviews, and urgency are real or flagged
   `[PROOF NEEDED]`, regardless of which skill is producing.
5. **One leader at a time.** The leading skill's own UX rules win while it leads (for
   example, content-factory's button-driven flow and stage banners, the vlog pipeline's
   silence until the gate passes).
6. **Handoffs are explicit.** When switching skills, state in one line what artifact moves
   forward ("Brief locked; starting the content plan"). No tool narration, no internals.
7. **Don't re-ask what a previous stage answered.** Carry the brief, brand, palette, and
   audience forward; only ask for what the next skill genuinely lacks.

## When the user asks "what can you do"

Answer with the suite in plain words, one line per capability, then offer the three
pipelines as buttons. Do not list file paths or skill mechanics to the user.
