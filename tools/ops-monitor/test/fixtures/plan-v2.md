# Release plan, 2026-10-23 v2 (acme fixture)

## Summary

| Train | Rows | Budget |
| ----- | ---- | ------ |
| T0    | 1    | 0.2    |
| T6    | 35   | 1.0    |

## Trains, this week

| #    | Train and goal                 | Items (row, short title)                                                           | Lane | Tier | Depends        | Budget | Tag                |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------- | ---- | ---- | -------------- | ------ | ------------------ |
| T0   | **Deadlines and live hazards** | <ul><li>SA-1: remove the log line.</li><li>Done today: hotfix + row 731.</li></ul> | MML  | 2    | none           | 0.2    | U                  |
| T5a  | **Counter, part 1**            | <ul><li>**B501 / row 498** dedupe.</li><li>**Row 746** receipt wording.</li></ul>  | MML  | 1    | none           | 1.4    | U                  |
| T12a | **Infra this week**            | <ul><li>Dependabot #3597.</li><li>Row 743 revert guard.</li></ul>                  | MML  | 2    | a quiet window | 0.8    | U (#3597 by 10-24) |

## Later

| #   | Train and goal      | Items                                        | Lane          | Tier | Depends     | Budget | Tag   |
| --- | ------------------- | -------------------------------------------- | ------------- | ---- | ----------- | ------ | ----- |
| T5b | **Counter, part 2** | <ul><li>Rows 736/737 dated checks.</li></ul> | WIN           | 1    | T5a         | 2.0    | A1    |
| T12 | **Infra and ops**   | <ul><li>Backups drill, row 712.</li></ul>    | you           | 2    | none        | 3.0    | A1-A2 |
| T16 | **Backlog**         | Verified first, one batch                    | cluster owner | 2    | after 11-01 | 2.5    | A3    |
