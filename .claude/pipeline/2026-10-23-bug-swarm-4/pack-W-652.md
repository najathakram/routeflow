1e162686ae8f2229119104cd4cfe1eb722537ba3
# Row W-652: Client-name mask list read from machine-local file

## Liveness
tools/ops-monitor/lib/mask.mjs:2,9,11 NAMES_FILE=client-names.json under opsHome; README.md:118; server.mjs:639,654; snapshot.mjs:1095.

## Files / signatures
namesFile(env,home); NAMES_FILE; BRIEF_DISABLED_NOTE; readSource(text,label)

## Radius
lib/mask.mjs, lib/config.mjs, lib/snapshot.mjs, server.mjs, README.md, test/brief.test.mjs

## Lessons
L-309 check ignored files before removing worktrees; L-294 find all readers before changing a source
