# render-kit — read before you render

You are about to use a shared render harness. One rule governs *how* the work is dispatched, and it
applies in every repo, not just the one that wrote it down.

## Check whether this repo routes render work

```bash
# from your working directory
f=$(d=$PWD; while [ "$d" != / ]; do [ -f "$d/standards/asset-render-standard.md" ] && echo "$d/standards/asset-render-standard.md" && break; d=$(dirname "$d"); done); echo "${f:-none}"
```

**A path came back — the repo routes.** Read that standard before your first render. It sets the
model tier for the task and carries the repo's content gates. Do not render in your main loop; the
main loop cannot change model mid-session, so an inline render runs at whatever tier the session
already had and the tiers are inert. Dispatch to `render-mechanical`, `render-standard`, or
`render-judged` (user-level agents at `~/.claude/agents/`). A `PreToolUse` hook denies the first
inline render attempt and tells you the same thing.

**`none` came back — the repo does not route.** Rendering inline is allowed and nothing blocks you.
But before you render anything an outside reader will judge, say so in one sentence: this repo has
no render standard, so no content gate is being checked. If the asset carries copy, a price, a date,
a photograph, or a person's name, that sentence is the only thing standing between an unreviewed
asset and an audience.

## Adopting the routing in a new repo — one file

Copy the template and edit the gates. The three agents and the dispatch hook are already global and
find the file by walking up from the working directory; there is no hook edit, no settings change,
and no per-repo agent copy.

```bash
mkdir -p standards && cp ~/Workspace/dev/tools/render-kit/templates/asset-render-standard.template.md standards/asset-render-standard.md
```

The reference implementation, with real gates and the measurement behind its tiers, is
`~/Workspace/dev/apps/630/630-marketing-automation/standards/asset-render-standard.md`.

## What routing is worth, and what it is not

Measured over 367 `render-kit` tool calls across Claude Code sessions, 2026-07-15 to 2026-08-15:
301 ran on Opus 5. Orientation, self-test, data-prep and render-run turns averaged 725–766 output
tokens against authoring's 1,707, and were 161 of 367 turns. That spread is the headroom. Whether
routing actually reduces spend is **not yet measured** — re-run before claiming it does.

Routing sets which model does the work. It does not review the output. Every gate in a repo's
standard runs at every tier, and a human still approves anything an audience sees.
