# Asset render standard — TEMPLATE, edit before use

Copy to `<repo>/standards/asset-render-standard.md` and replace every `TODO`. The machinery —
`~/.claude/hooks/render-dispatch-guard.py` and the three `~/.claude/agents/render-*.md` tier agents —
finds this file by walking up from the working directory. Its presence is what turns routing on.

Same three-part shape as any standard: a **rule**, a **source of fact**, and a **check**.

## Render work is dispatched, not done inline

**Rule R-0.** An agent does not render assets in its own main loop. It reads this standard, names
the tier, and dispatches to the matching agent at `~/.claude/agents/`. The model switch happens only
at that dispatch — a main loop never changes model mid-session.

**Check.** Mechanical. `render-dispatch-guard.py` denies the first inline `render-kit` execution per
session in any repo carrying this file. Orientation reads and self-test runs are never denied. The
deny fires once and the retry passes.

> **Scope caveat, read this.** The hook recognizes `render-kit` invocations. If this repo renders
> through its own script — `scripts/**/render-*.mjs` or similar — the hook will **not** fire and R-0
> is advisory here. Say so in this section rather than leaving it implied.

## Tiers

**Rule R-1.** Route on **who or what catches a wrong answer**, never on the task's name.

| Who catches a wrong answer | Tier | Model |
|---|---|---|
| A mechanical gate — self-test, contract test, pixel diff | Mechanical | `haiku` |
| A gate exists, but the work is real editing | Standard | `sonnet` |
| A person judges it on appearance, or failure is silent | Judged | `opus` |

**Rule R-2.** A task takes the **highest** tier any row matches. Nothing de-escalates mid-task.

**Check.** Before dispatch, name the command that would fail if the output were wrong. If you cannot
name one, the task is Judged.

## Gates that run at every tier

**Rule R-3.** Tier changes the model. It changes nothing here. Cheaper does not mean looser.

0. **Rendering is not approval.** TODO — name who approves before an audience sees the asset, or
   delete this gate if the output is internal only.
1. TODO — people in the asset. Consent, likeness, minors.
2. TODO — money. Which prices may appear, and the one source they come from.
3. TODO — type and color. The brand file that owns them.
4. TODO — fact provenance. Where names, dates and figures come from.

**Check.** TODO — say for each gate whether a machine or a named human checks it. A gate with no
check is not a gate yet; write that down rather than implying enforcement.

## Escalation

**Rule R-4.** A Mechanical or Standard dispatch stops and re-dispatches at Judged if the self-test
fails in a way it cannot localize in one edit, the task turns out to touch copy or a price or a date
or a photograph, or the output is headed outside the repo.

## What would change this standard

TODO — name what evidence would move a tier assignment or retire a gate. A standard with no
falsifier is a preference.
