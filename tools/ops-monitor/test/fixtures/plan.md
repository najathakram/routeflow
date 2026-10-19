# Release plan R1-R3: ship everything open (lead, 2026-10-18 20:15Z)

Master `abc1234`. Rules: one train per public window.

## Product page: the "no issues" bar

1. **K14 >= 90%** with no objection.

## Trains

| Train                                       | Members                                                                                                 | Lanes                  | Gates                                 | ETA (window)  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------- | ------------- |
| **R1 window 2: back office + widget fixes** | fix/acme-bo-api (BO-03) · feat/acme-bo-web 37266348d · rows 101/102, row 103 · B1036 · riders a6247ee7e | MB push; PC-L BO fixes | MB single verified push; Opus review  | 10-18 ~23:30Z |
| **R2 billing guards (live harm)**           | G1a a40de03bb (SA-786) · rows 105, 999 · B1234                                                          | PC-L                   | rebase on master; DB specs; Opus high | 10-19 ~04:00Z |
| **R3 product page finish**                  | K13 first; B6 is not an id                                                                              | MM, PC-L               | K13 on the R1 image                   | 10-19 ~16:00Z |

## After R3

Nothing else.
