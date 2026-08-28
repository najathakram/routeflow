# AI Style Avoidance

Mandatory anti-pattern system. The goal is not to beat detectors (detectors are unreliable
and markers shift). The goal is to eliminate the habits that make writing feel synthetic,
generic, over-produced, pseudo-insightful, promotional, or structurally mechanical, and to
replace them with the habits of a knowledgeable human who made decisions.

Core principle: **a single flagged word is rarely a problem; clusters are the problem.** The
strongest tells are repeated rhetorical structures, empty abstraction, generic
interpretation, weak provenance, overly regular organization, and sentences that could be
written about almost any subject. Density is the alarm, not presence.

Second principle: **fix causes, not symptoms.** Swapping a banned word for a synonym leaves
the synthetic skeleton intact. Rewrite the thought.

Contents:
- Part 1: The Seven Root Causes
- Part 2: The Rewrite Protocol (five moves)
- Part 3: Pattern Library
  - 3A. Generation leakage
  - 3B. Template openings and endings
  - 3C. Interpretation and inflation
  - 3D. Abstraction and AI vocabulary
  - 3E. Empty business and marketing language
  - 3F. Manufactured rhetoric
  - 3G. Structure and formatting tells
  - 3H. Audience and empathy fakery
  - 3I. CTA and engagement-bait patterns
  - 3J. Domain cliché packs (tourism, wedding, SEO, tech)
  - 3K. Evidence, precision, and epistemic tells
  - 3L. Cadence and punctuation tells
  - 3M. Newer tells to watch
- Part 4: Sales-Copy-Specific Tells
- Part 5: The Three-Pass Audit
- Part 6: What Good Looks Like
- Part 7: Myths and the Anti-Humanizer Rule

---

# Part 1: The Seven Root Causes

Almost every tell in Part 3 grows from one of these seven behaviors. Learn the roots and the
word lists become confirmation, not the method.

**Root 1: The interpretation reflex.**
Reporting a fact and then immediately explaining why it matters, in the abstract, every
time. Produces participial tails ("...highlighting the importance of"), significance
inflation ("marks a pivotal moment"), and pseudo-profundity ("more than just a photo").
Humans let strong facts sit. Interpretation is earned occasionally, not appended constantly.

**Root 2: Genre completion.**
Writing what "a blog post" or "a landing page" statistically contains instead of what this
one needs to say: the standard intro, the balanced pros and cons, the rule-of-three benefits,
the hopeful conclusion, the FAQ. Produces template openings and endings, fake balance,
manufactured triples, and interchangeable structure. Humans write from a decision about what
matters; the shape follows the decision.

**Root 3: Missing provenance.**
Nothing in the text that the writer could only know by doing the work: no measurement
artifact, no exact customer objection, no workflow quirk, no failure, no local detail, no
trade-off. Produces source-stitched consensus prose that fits any brand. The test: what
sentence here could a competitor not paste onto their own site?

**Root 4: Abstraction drift.**
Categories instead of instances, nouns instead of verbs, qualities instead of events.
"Enhanced operational efficiency" instead of "invoices go out the same day." Produces
nominalization stacks, vocabulary clusters, and emotional abstraction ("connection",
"journey", "moments"). Humans anchor in the concrete and abstract only when the concrete has
been paid for.

**Root 5: Symmetry addiction.**
Every paragraph the same length, every bullet the same shape, every section the same size,
every heading the same grammar, a transition word at every joint. Produces mechanical
structure and connector addiction. Human emphasis is asymmetric: important things get space,
minor things get a clause.

**Root 6: Risk spreading.**
Hedging every claim, addressing every possible audience, balancing every point, ending every
hard topic with vague optimism. Produces "designed to help", "whether you're a beginner or an
expert", "while X offers benefits, it also presents challenges", and automatic hopeful
endings. Humans commit: one audience, one position, real trade-offs stated plainly.

**Root 7: Performed humanity.**
Simulating voice with staged candor ("Let's be honest", "Real talk"), forced casual
fragments, fake vulnerability, or deliberate errors. This is the humanizer trap: it replaces
the corporate mask with a folksy mask. Voice comes from judgment, specificity, and stake,
never from costume.

---

# Part 2: The Rewrite Protocol

When a passage smells synthetic, do not synonym-swap. Apply one of these five moves.

**Move 1: Replace interpretation with consequence.**
Cut the abstract "why it matters" and state what concretely happens or changes.
- Before: "The new booking system streamlines the client experience, reflecting our
  commitment to convenience."
- After: "Couples pick a date, sign, and pay in one sitting. Booking takes eleven minutes
  instead of a week of emails."

**Move 2: Replace the category with the instance.**
Swap the general noun for the specific thing, person, number, or moment.
- Before: "We capture the meaningful moments and authentic emotions of your special day."
- After: "We're there when your dad sees you in the dress and pretends he isn't crying."

**Move 3: Replace the claim with the proof.**
If evidence exists, show it instead of asserting the quality. If it does not exist, shrink
the claim to what is true or flag `[PROOF NEEDED]`.
- Before: "Our industry-leading support team delivers exceptional service."
- After: "Support answers in under four hours, weekends included. Last month's median was
  51 minutes."

**Move 4: Replace symmetry with emphasis.**
Break the uniform pattern. Give the one important point three sentences and fold the minor
points into one. Delete the transition if the logic carries itself. Vary sentence length on
purpose.
- Before: three bullets, each "**Label:** twelve-word sentence."
- After: one strong paragraph about the thing that matters, with the two minor points as a
  single trailing sentence.

**Move 5: Replace the template with a decision.**
Ask what this specific reader needs to believe to act, write only that, and order it by
force rather than by convention. If the standard section adds nothing here, it does not
appear. If the conclusion has nothing to add, the piece ends on the last useful sentence.

Apply moves recursively: after rewriting, rescan. One pass rarely clears a dense passage.

---

# Part 3: Pattern Library

Scan lists. Presence of one item is a nudge; clusters are a rewrite order. Items are not
banned when they are the exact right word; they are banned as defaults.

## 3A. Generation leakage

Never allow finished copy to contain assistant or scaffolding language:

- Certainly! / Absolutely! / Of course! / Great question.
- Here's a breakdown / Here's a comprehensive overview / Below is a detailed...
- Here is the revised version / I've rewritten this / I can also... / Would you like me to...
- Let me know if you'd like... / I hope this helps / Feel free to...

Never expose internals: prompt text, model names, tool names, search-result IDs, citation
markup, JSON or XML fragments, system metadata, file paths, or generation comments.

Forbidden leftovers: [INSERT COMPANY], [CTA], [URL], [ADD TESTIMONIAL], [TARGET KEYWORD],
[SOURCE], TBD, XX%, "Tone:", "Audience:", "Word count:". The single allowed placeholder
format is the explicit `[PROOF NEEDED: description]` flag, and only when the user must
supply real evidence.

## 3B. Template openings and endings

Openings that mark genre completion (Root 2). Avoid:

- In today's fast-paced world / digital age / competitive landscape
- In an increasingly connected world / In an ever-evolving landscape / In the modern era
- In recent years... / As technology continues to evolve... / As businesses navigate...
- When it comes to... / In the realm of... / In a world where...
- At its core... / Navigating the complexities of...
- Understanding X is crucial / X has become increasingly important / The rise of X has
  transformed...
- Imagine a world where... / Picture this: (as a default device)

Open instead with: a fact, a scene, a problem, a result, an observation, a decision, a
claim, a contradiction, or the buyer's current reality. The first sentence should be
impossible to reuse for another topic.

Endings that mark genre completion. Avoid:

- In conclusion / To sum up / Ultimately / Overall / All in all
- Looking ahead / Moving forward / As we look to the future
- The future of X is promising / As X continues to evolve / Only time will tell
- The key takeaway is / The bottom line is / At the end of the day
- By embracing X... / With the right approach... / By staying informed and adaptable...
- The possibilities are endless.

Also avoid the automatic recovery ending on hard topics ("Despite these challenges,
continued innovation and collaboration will be essential") and generic futurism ("poised
to", "the next frontier", "shape the future"). End when the useful thought is complete. In
sales copy, end on the ask.

## 3C. Interpretation and inflation

Significance inflation (Root 1). Avoid attaching grand meaning to ordinary facts:

- highlights / underscores the importance of; underscores the need for
- demonstrates the significance of; reflects broader trends; reflects the growing
  importance of
- represents a significant milestone; marks an important step; marks a pivotal moment
- serves as a testament to; stands as a testament to; reinforces its position
- signals a broader shift; contributes to the evolving landscape; speaks to the importance of
- leaves a lasting legacy; has a profound impact; paves the way for; shapes the future of

If significance is real, state the concrete consequence (Move 1).

Participial tails. One interpretive "-ing" clause can be natural; repetition across
paragraphs is a synthetic rhythm. Watch sentence endings in:

highlighting, underscoring, showcasing, emphasizing, reinforcing, reflecting, demonstrating,
enabling, allowing, ensuring, fostering, facilitating, contributing, supporting, paving,
positioning, driving, creating, making.

Prefer a separate direct statement, or cut the interpretation.

Pseudo-profundity. Avoid dressing ordinary facts as philosophy:

- More than a photo... / More than a product... / Not just a memory...
- Some moments need no words. / A story told without words. / The moments between the
  moments.
- This is what it's all about. / A reminder that... / Where X meets Y.
- At the heart of... / At its core... (as aphorism launchers)

False aphorisms. Question quotable-sounding lines that add nothing:

- Great marketing isn't about selling. It's about connecting.
- Technology should work for people, not the other way around.
- Your brand is more than a logo. It's an experience.
- Data is only valuable when it leads to action.

If it sounds wise but changes nothing for the reader, cut it. Real profundity survives being
stated plainly.

Generic causal verbs. Question "driving, fostering, enabling, contributing to, leading to,
resulting in, promoting, accelerating" whenever causation has not been shown.

## 3D. Abstraction and AI vocabulary

Nominalization overload. Prefer verbs over abstract nouns:

implementation, optimization, utilization, enhancement, integration, transformation,
evaluation, consideration, establishment, determination, identification, facilitation,
deployment, alignment, incorporation, engagement, collaboration.

- Weak: "The implementation of API integration resulted in improved efficiency."
- Better: "We integrated the API, and invoices now go out the same day."

Inflated simple verbs. Prefer is, has, uses, helps, shows, makes, starts, combines, changes
over the ceremonial defaults: serves as, stands as, functions as, represents, emerges as,
boasts, features, leverages, utilizes, facilitates, showcases, harnesses, marks the
beginning of, seamlessly integrates. Plain verbs sound more authoritative, not less.

AI vocabulary clusters. Extra caution when several of these appear near each other:

delve, delving, intricate, intricacies, realm, tapestry, landscape, multifaceted, nuanced,
interconnected, interplay, pivotal, paramount, crucial, transformative, groundbreaking,
remarkable, profound, vibrant, robust, holistic, seamless, meaningful, impactful, dynamic,
evolving, burgeoning, pioneering, compelling, invaluable, noteworthy, significant, showcase,
underscore, foster, align, resonate, enhance, elevate, empower, unlock, embark, journey,
testament, beacon, cornerstone, catalyst, synergy, streamline, supercharge, game-changer,
game-changing, cutting-edge, state-of-the-art, next-level, ever-changing, fast-paced.

Not absolutely banned when exact. Density is the warning.

Generic emotional abstraction. Watch overuse of: journey, story, connection, meaningful,
intentional, authentic, timeless, moments, memories, magic, beauty, joy, passion, purpose,
belonging, community, experience, emotion, essence, heart, soul, cherish, embrace. Emotion
must come from a specific event, detail, consequence, or truth (Move 2).

Single-word entries that demand their own test:

- **"increasingly" / "growing" / "rapidly evolving"**: compared with when, based on what?
  Cut without evidence.
- **"navigate"**: describe the actual task instead.
- **"foster"**: name the behavior that creates the result.
- **"drive"**: state what changes and by what mechanism.
- **"meaningful"**: what specifically makes it meaningful?
- **"actionable insights"**: an insight is actionable only if it changes a decision. Name
  the decision.
- **"data-driven"**: if the data is not shown or described, do not claim it.
- **"holistic"**: if it just means "many things", say the things.
- **"robust"**: robustness requires a named stress condition.
- **"scalable"**: name the scale. Ten customers? 100,000 users? 64 radio units? Never alone.
- **"seamless"**: describe the actual integration, migration, setup, or handoff.
- **"intuitive"**: needs user behavior or evidence, otherwise cut.
- **"tailored"**: mass-produced copy may not claim tailoring unless real customization
  occurs.

## 3E. Empty business and marketing language

Aggressively question:

actionable insights, valuable insights, deeper insights, meaningful impact, meaningful
results, sustainable growth, data-driven approach, data-driven decisions, tailored
solutions, unique needs, strategic initiatives, innovative solutions, customer-centric,
holistic strategy, dynamic ecosystem, strategic alignment, seamless integration, robust
framework, scalable solution, industry-leading, best-in-class, world-class, cutting-edge,
future-ready, next-generation, commitment to excellence, unwavering commitment, attention
to detail, trusted partner, deliver value, drive growth, drive engagement, drive
innovation, drive results, unlock potential, harness the power of, elevate your brand,
transform your business, take it to the next level, redefine what's possible, stay ahead of
the curve, stand out in a crowded market, navigate the complexities, peace of mind (as
filler), hassle-free, one-stop shop, look no further, we've got you covered, at your
fingertips.

Replace with the actual mechanism, proof, or consequence (Move 3).

Corporate press-release language: commitment to excellence, dedication to innovation,
strategic initiatives, continued growth, strong track record, dynamic team, trusted
partner, delivering value, strengthening its position, expanding its footprint, fostering
collaboration, driving meaningful change. If the claim matters, show the action.

Weak intention language. At persuasive stages, state what actually happens rather than what
the product is meant to do: designed to help, built to help, created to, aims to, seeks to,
intended to, can help, may help, could potentially, enables you to, allows you to,
supports, facilitates.

- Weak: "Designed to help you manage leads more efficiently."
- Better: "Every inquiry, reply, proposal, and follow-up sits in one pipeline."

Partial-sentence tells. Scan specifically for these fragments:

designed to help you, helping you, so you can, so you can focus on what matters most,
whether you're X or Y, from X to Y, without compromising, without the hassle, without
sacrificing, tailored to your unique needs, empowering teams to, enabling businesses to,
providing a seamless, make smarter decisions, drive meaningful results, achieve sustainable
growth, what matters most, take the next step, ready to transform, ready to get started,
discover how, in today's, at the heart of, at its core, more than just, not only, paving
the way, positioning you to, future-ready, changing landscape, ever-evolving, rapidly
evolving, growing importance, growing demand, that's where X comes in, Enter X.

Do not mechanically swap synonyms for these. Rewrite the thought.

Generic value-proposition syndrome. Reject any sentence that could fit thousands of
companies ("We help businesses streamline operations, improve efficiency, and achieve
sustainable growth through innovative solutions tailored to their unique needs."). A value
proposition must contain: who, the problem, the mechanism, the meaningful difference, and
proof or a credible reason to believe.

Generic differentiation. "What sets us apart is our commitment to quality, personalized
service, and attention to detail" differentiates nothing, because every competitor can say
it. Use only what competitors cannot truthfully claim.

Product benefit fog. Do not float features up into lifestyle abstraction.
- Feature: cloud sync. Weak: "Stay connected wherever life takes you."
- Better: "Start the draft on your laptop. Finish it on your phone without emailing
  yourself a file."

"Without X" formula (use sparingly): without the hassle, without sacrificing quality,
without breaking the bank, without compromising performance, without the guesswork. State
the actual avoided cost where possible.

"Imagine..." visualization: "Imagine having more time for what matters" is generic. If
visualization is used, it must be specific enough to belong only to this offer.

Generic experience language: seamless experience, personalized experience, immersive
experience, elevated experience, exceptional experience, unique experience. Describe what
happens differently.

"From X to Y" universality: "from strategy to execution", "from concept to completion",
"from first click to final conversion". Use only when the endpoints describe a real scope.

## 3F. Manufactured rhetoric

Manufactured contrast. Avoid habitual:

- It's not X. It's Y. / It's not just X. It's Y. / This isn't just about X.
- More than just X. / Not merely X, but Y. / Not only X, but also Y.
- X is more than Y. / Rather than simply X... / The goal isn't X. It's Y.
- Success isn't about X. It's about Y.

Use contrast only when a real contrast matters. Never invent a weak position just to reject
it; that is a strawman and violates the agreement rule from the doctrine.

Fake-candid hooks (Root 7): Honestly?, Let's be honest, Real talk:, The truth is..., Here's
the thing., Here's what nobody tells you., Nobody talks about this., Hot take:, Unpopular
opinion:, I said what I said., You need to hear this., Stop scrolling., Spoiler alert:,
Fun fact: (as filler), (yes, really).

Forced punchline fragment stacks. Recognizable generated-social rhythm:

"More content. More noise. Less connection." / "No fluff. No gimmicks. Just results." /
"Faster. Smarter. Better."

Occasionally one lands; repeated stacks are a tell. Use only when the rhythm is genuinely
earned, at most once per asset.

Rule of three. Do not manufacture triples (fast, simple, scalable; clarity, confidence,
control; attract, engage, convert; plan, execute, optimize). Two real ideas get two; four
get four. Never invent the third for rhetorical completion.

Excessive rhetorical questions. So why does this matter?, What does this mean for
businesses?, But what makes X different?, What if there were a better way?, The result?,
The best part?, Sound familiar? Questions must create real tension, never act as automatic
transitions. Maximum one rhetorical question per short asset, and only if it earns its
place.

Perfect LinkedIn wisdom shape. Avoid the template: personal realization, short fragment,
short fragment, contrarian claim, three lessons, leadership conclusion, engagement
question. Do not imitate platform clichés even when writing for the platform.

## 3G. Structure and formatting tells

Synonym cycling. Do not rotate terms for variety (company, organization, firm, enterprise,
entity, brand; product, solution, offering, platform, tool, system). Natural repetition is
allowed; clarity outranks lexical variety.

Connector addiction. Avoid automatic paragraph starts: Additionally, Moreover, Furthermore,
Nevertheless, Nonetheless, Consequently, Therefore, Thus, Hence, Importantly, Notably,
Interestingly, Significantly, Ultimately, Overall, In addition, On the other hand, That
said, With that in mind, It's worth noting, Needless to say, Not to mention. Use a
transition when logic requires a bridge, not because a paragraph started.

Road-sign writing. Do the thing instead of announcing it: Let's take a closer look, Let's
break this down, Let's dive in, Let's explore each one, Here are the key points, There are
several key factors, Before diving deeper, Now that we've established, This brings us to,
The next step is, Without further ado.

Mechanical structure. Watch for: every paragraph the same length; every paragraph the same
rhetorical function; every bullet the same length; every heading the same grammar; every
section the same size; the universal article shape (intro, definition, benefits,
challenges, future, conclusion, FAQ) applied to everything; empty parent headings; tiny
one-paragraph subsections; automatic "Key Takeaways". Structure must follow information.

Bold-label bullet syndrome. Avoid habitual "**Efficiency:** ...", "**Scalability:** ...",
"**Flexibility:** ..." lists when prose is better. Do not turn every answer into a mini
reference manual.

Excessive formatting. Do not default to many heading levels, horizontal rules, emoji
headings or emoji bullets, nested lists, comparison tables, checklists, FAQs, key-insight
boxes, or summary boxes. Formatting must improve usability, not expose chatbot habits.
Marketing prose in particular should read as writing, not as documentation.

Over-explaining. Delete obvious caveats, obvious transitions, generic reminders, universal
disclaimers, a summary after a summary, and any sentence that explains what its own heading
already said. Human editing requires sacrifice.

Unnecessary definitions. Do not open advanced content by defining basics the reader knows,
and never define the title just for completeness.

False completeness. "Ultimate guide", "complete guide", "definitive guide", "everything you
need to know" only when the scope truly supports it.

## 3H. Audience and empathy fakery

Universal audience language. Choose an audience. Avoid: Whether you're a beginner or an
expert..., Whether you're a small business or a large enterprise..., No matter your
experience level..., For businesses of all sizes..., Whatever your goals...

Surface empathy. Avoid: We know how overwhelming this can feel., We understand that every
journey is different., We know your time is valuable., You deserve..., That's why...
Specific understanding beats generic sympathy: name the actual situation.

Generic pain-point copy. Avoid the template: Struggling with X?, Tired of X?, Feeling
overwhelmed?, We understand how frustrating X can be., You're not alone., That's where we
come in., Say goodbye to X., What if there were a better way?, It doesn't have to be this
way. Use real pain in real customer language, drawn from the brief.

Fake personalization. Avoid: I came across your company and was impressed by..., I noticed
the amazing work you're doing..., Given your role as..., I know companies like yours often
struggle with..., I thought this might be relevant to your goals. Personalization must
reference something real, specific, and useful, or be omitted.

Generic cold-email stack. Do not mechanically produce: polite opener, fake compliment,
assumed pain, three benefits, social proof, 15-minute-call CTA, soft opt-out. A cold email
is built around the actual reason for contact (see channel playbooks).

## 3I. CTA and engagement-bait patterns

Generic CTA language. Avoid automatic: Learn More, Discover More, Explore, Get Started
Today, Unlock, Transform, Elevate, Begin Your Journey, Ready to Get Started?, See What's
Possible, Let's Make It Happen, Take the Next Step, Don't Miss Out, Act Now.

Use the action itself, with assumptive energy per the doctrine: See pricing, Check
availability, Pick your date, Reply with your date, Book the call, Compare plans, Download
the guide, Start the trial, Send the brief, Reserve your spot.

Social hook templates. Avoid overuse of: Nobody talks about this., Here's what no one tells
you., You need to hear this., Stop scrolling., Hot take:, POV:, The truth about..., Here's
the secret..., You're doing X wrong., Most people get this wrong., I wish I knew this
sooner., Save this., Read that again., Let that sink in. Hooks come from the idea, not a
template. "You're doing X wrong" additionally violates the agreement rule.

Engagement-bait endings. Do not automatically append: What do you think?, Agree?, Can you
relate?, Which one resonates?, Drop your thoughts below., Comment below., Tag someone.,
Send this to someone., Save this for later., Follow for more. Ask only when there is a real
conversational reason.

## 3J. Domain cliché packs

Tourism and place. Avoid: nestled in the heart of, breathtaking views, vibrant culture,
rich history, picturesque, hidden gem, charming, stunning landscapes, natural beauty,
cultural heritage, bustling, serene, idyllic, enchanting, must-visit destination, offers
something for everyone, perfect blend of, rich tapestry of, steeped in history. Use actual
place detail: the specific street, the specific dish, the specific light at a specific hour.

Wedding and lifestyle. Use caution with clusters of: timeless, authentic, intentional,
candid, raw, genuine, emotion, connection, storytelling, story, chapter, moments, memories,
fleeting, forever, cherished, unscripted, effortless, intimate, meaningful, magic, quiet
moments, in-between moments, love story, tell your story, preserve your memories, capture
the essence, beautifully imperfect, deeply personal, uniquely yours. Every studio on earth
uses these. Make each event sound like itself: real venues, real weather, real family
dynamics, real details from real galleries.

SEO query mirroring. Never write "Finding the best CRM for wedding photographers can help
wedding photographers choose the best wedding photographer CRM." Avoid: the exact query
repeated in the intro, the exact query in every heading, awkward keyword variants,
city-swapped pages, generic People Also Ask sections, formulaic meta descriptions, padded
definitions, automatic FAQ blocks. Search intent first, keyword second, and the keyword
appears where a human would naturally put it.

Technical prose. Use caution with: leverage, utilize, employ, facilitate, enable, enhance,
optimize, streamline, integrate, encompass, demonstrate, address, mitigate, framework,
methodology, paradigm, architecture, capability, functionality, robustness, scalability,
interoperability, significant, substantial, promising. Technical vocabulary is allowed when
exact; the tell is vague technical prose with no reproducible detail. Reject technically
plausible but empty claims ("The proposed framework leverages an optimized architecture to
enhance performance while ensuring scalability and robustness."). Demand: which
architecture, optimized for what, under what constraints, which metric, what baseline, what
measured improvement, scalable to what load, robust under what disturbance. If unknown,
narrow the claim.

## 3K. Evidence, precision, and epistemic tells

Fake precision. Never invent percentages, latency figures, conversion lifts, dates, version
numbers, standards clauses, customer counts, test results, page references, or citations.
Specificity must be real. Invented precision is the worst possible tell because it is also
a lie.

Unsupported authority. Avoid vague appeals: studies show, research suggests, experts agree,
analysts believe, industry leaders say, recent reports indicate, a growing body of
research. Name the evidence when available; otherwise remove or qualify.

Source-count inflation. One article is not "numerous publications." One expert is not
"experts." One complaint is not "customers say." Never create consensus.

Fake balance. Do not force "While X offers several benefits, it also presents a number of
challenges" onto every topic. Take the structure the subject deserves. Real trade-offs get
stated concretely; imaginary ones get cut.

Low epistemic texture. Good expert writing distinguishes measured, observed, reported,
inferred, estimated, assumed, uncertain, and unknown. Do not flatten everything into one
confident explanatory voice. In marketing this shows up as claiming certainty about the
reader's situation; write what is known, offer what is likely, and ask what is not known.

Semantic repetition. Do not restate one idea through synonyms (improves visibility,
provides greater insight, increases transparency, allows better understanding). Each
sentence must add information. If two sentences make the same claim, keep the stronger one.

No-cost knowledge. Ask of every piece: what here could the writer only know by actually
doing the work? Prefer exact objections heard from real customers, unusual behavior
observed, a measurement artifact, a workflow quirk, a local detail, a failure, a surprise,
a trade-off, a specific number, a physical observation. If the draft contains only cheaply
inferred knowledge, go back to the user for one real detail; a single real detail outsells
three paragraphs of consensus.

## 3L. Cadence and punctuation tells

- **Uniform sentence length.** Runs of sentences within a couple of words of the same
  length read as machine rhythm. Vary deliberately: one long build, one short landing.
- **The two-to-three-sentence paragraph forever.** Especially in "humanized" output. Let
  one paragraph run long when the thought does, and let one sentence stand alone when it
  has earned it.
- **Dash addiction.** This skill bans em dashes and en dashes outright (house style). Do
  not replace them with a semicolon habit; restructure the sentence.
- **Colon-headline formula.** "X: Why It Matters and What You Can Do" shapes. Occasional
  colons fine; the formula is the tell.
- **Exclamation inflation.** More than one exclamation point per asset is suspect; in B2B,
  usually zero.
- **Quotation-mark scare quotes** around ordinary words ("results", "quality") signal
  either irony or nerves; both undermine copy.
- **Perfectly parallel headings.** All gerunds, or all questions, or all "How to X" reads
  as generated. Mix grammatical forms the way a human editor would.

## 3M. Newer tells to watch

Keep scanning for these recognizable recent habits:

- "Here's the kicker", "And the best part?", "The result?" as pivot fragments.
- "Think: x, y, z" constructions.
- "It's not about X, it's about Y" in its newer compressed forms ("Less X. More Y.").
- "TL;DR" headers in polished marketing prose.
- "Pro tip:" sprinkled more than once.
- "chef's kiss", "*mic drop*", "IYKYK" and other borrowed-meme voice in brand copy.
- Emoji as bullet points or section markers in professional assets.
- "In a sea of X", "cut through the noise", "move the needle", "low-hanging fruit",
  "secret sauce", "north star" cluster.
- "We get it." as an empathy opener.
- "No fluff" promises (a promise of substance is not substance).
- Triple-question openers ("Struggling with X? Tired of Y? Wish there was Z?").
- The apology-free apology ("We know forms are boring, but...").
- Overuse of "actually" and "literally" as sincerity boosters.
- "Your X, supercharged" and "X, reimagined" headline formulas.
- Ending social posts with a single-word sentence of affirmation. Powerful. (Like that.)

---

# Part 4: Sales-Copy-Specific Tells

Patterns that mark copy as generated AND as amateur selling. Each one violates the doctrine.

1. **Describes but never asks.** Pages or emails that inform and trail off. Every
   persuasive asset asks, specifically and confidently, at least once. (Commandments 9, 10.)
2. **The discount reflex.** Reaching for money-off language as the first response to price
   sensitivity. Handle price with value, options, and moving up. (Price myth.)
3. **The feature dump.** Presenting everything the product contains instead of what this
   reader values. Symptom of a skipped step 2. Curate and translate. (Five-step process.)
4. **Making the reader wrong.** "You're doing it wrong", "Stop wasting money on X", "Most
   people fail because..." Openings that shame current behavior. Agreement first, always.
5. **Unproven superiority.** "Best", "leading", "top-rated", "#1" with nothing attached.
   Show it or cut it. (Show, don't tell.)
6. **Fake urgency.** Countdown timers with no real deadline, "only 2 left" fictions,
   evergreen "sale ends tonight". Fails the advertisability test and destroys the trust
   the rest of the page built. Real urgency only: real capacity, real dates, real cost of
   waiting.
7. **The apologetic ask.** "Sorry to bother you", "Just checking in", "Just bumping this",
   "No pressure at all", "Whenever you get a chance". This is unsold conviction leaking
   into the copy. Every touch is confident, positive, and service-framed.
8. **"We" copy.** Paragraphs about the company's passion and history where the reader
   wanted their problem solved. Count pronouns; "you" wins. (People business.)
9. **Value below price.** A value presentation that lists items roughly equal to the
   number, then asks. The stack must visibly exceed the price before any ask. (Super freak
   demonstration.)
10. **Competitor bashing.** Direct or silhouetted attacks. Dominate with the offer instead.
11. **The hidden offer.** No figures, no packages, no next step, "contact us for pricing"
    as the entire proposal. Always get to a proposal. (Step 4.)
12. **One-touch sequences.** A single follow-up email labeled "sequence." Real sequences
    run 6 to 12 touches with varied angles and value in every message. (Massive action.)

---

# Part 5: The Three-Pass Audit

Run all three passes on every deliverable before it ships. Fix and rescan; one pass through
a dense draft is never enough.

## Pass 1: Skeleton

- Does the structure follow this information, or a genre template?
- One page, one goal? One section, one idea?
- Is there a real greet, a real value build, a real proposal, and a real close?
- Is emphasis asymmetric (the important thing gets the space)?
- Could any section be deleted with no loss? Delete it.

## Pass 2: Claims

- Does every claim carry proof, a specific, or a mechanism? If not: shrink it, show it, or
  flag `[PROOF NEEDED]`.
- Any invented numbers, sources, consensus, or precision? (Instant fail.)
- What here could only be known by doing the work? If nothing, request one real detail.
- Would every tactic and claim survive being advertised publicly as-is?
- Are known objections agreed with and reframed, never argued with?
- Does the value stack visibly exceed the price before the ask?

## Pass 3: Language

- Scan the pattern library sections relevant to the asset. Count flagged items; clusters
  get rewritten via the Protocol, not synonym-swapped.
- Read it aloud in your head. Any sentence that would embarrass a human saying it to a
  customer's face gets rewritten.
- Cadence: sentence lengths varied? Paragraph sizes varied? Transitions only where logic
  needs them?
- Zero em dashes, zero en dashes, anywhere.
- Kill questions, answered honestly:
  1. Does the opening or ending sound like a template?
  2. Did I explain why any ordinary fact "matters"?
  3. Are there stacked participial tails or inflated verbs?
  4. Is there a manufactured contrast, forced triple, or fragment stack?
  5. Could any paragraph be pasted onto a competitor's site unchanged?
  6. Is there a sentence that sounds impressive but means little?
  7. Is anything here only because "good writing should have it"?
  8. Does the reader get asked to act, specifically, at least once?
  9. Does this sound like a knowledgeable person, or like a model completing a genre?

Revise until every answer is clean.

---

# Part 6: What Good Looks Like

Human expert copy has positive signatures, not just an absence of tells:

- **Specificity with provenance.** Details only this business could supply.
- **Asymmetric emphasis.** One idea dominates; minor points know their place.
- **Committed positions.** A chosen audience, a real opinion, stated trade-offs.
- **Concrete verbs and instances.** Things happen to people and objects, in order.
- **Confident, warm directness.** Says the thing, asks for the order, stays kind.
- **Selective imperfection of form, never of substance.** A one-sentence paragraph, a blunt
  aside, an uneven list, because emphasis demanded it.

Two compressed examples of the full protocol applied:

**SaaS, before:**
"Our innovative platform is designed to help businesses of all sizes streamline their
workflows, boost productivity, and unlock actionable insights, empowering teams to focus on
what matters most."

**SaaS, after:**
"Ops teams use Relay to cut invoice processing from nine days to two. Approvals, exceptions,
and audit trails sit in one queue, so month-end close stops eating the first week of the
next month. See pricing, or send us one messy invoice and watch it route."

**Wedding photography, before:**
"We are passionate storytellers dedicated to capturing the authentic, timeless moments of
your special day, preserving your memories so you can relive the magic for years to come."

**Wedding photography, after:**
"We photograph the ten seconds nobody plans: your grandmother fixing your veil, your
groomsmen failing to fold a pocket square, your dad's face during the first look. Full
galleries from real weddings are below. If one feels like your people, check your date
here."

---

# Part 7: Myths and the Anti-Humanizer Rule

**Over-polish myth.** Perfect grammar is not an AI sign by itself. Never damage good writing
to make it seem human. The problem is uniform polish combined with generic structure and
vocabulary. Keep professional quality.

**Passive-voice myth.** Passive voice is not automatically AI. Choose active or passive for
clarity and convention.

**Punctuation myth.** Authorship cannot be identified from punctuation. This skill avoids em
and en dashes because of the user's standing style preference, not as camouflage. Never
manufacture unusual punctuation to seem human.

**The Anti-Humanizer Rule.** Never humanize by adding typos, random slang, fake opinions,
fictional anecdotes, arbitrary choppiness, fake vulnerability, forced contractions, misused
punctuation, casualized terminology, or staged candor ("Honestly?", "Real talk"). Human
writing is context, judgment, specificity, and selective emphasis. That is the entire
secret, and it cannot be faked with costume; it can only be produced by actually making
decisions about this reader, this offer, and this page.
