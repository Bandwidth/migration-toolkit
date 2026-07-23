# Contributing

Thanks for helping make the Migration Toolkit better. Issues and PRs are the main way it improves, and they're genuinely welcome.

## How this project is supported

The Migration Toolkit is best-effort and community-supported — not a fully supported Bandwidth product. It's proven on real calls, but there's no team on it full-time, so response times vary and prioritization isn't guaranteed. If something's blocking you, the fastest path is usually a PR you drive yourself. For SLA-backed support on a production migration, talk to your Bandwidth account team.

## How to report a problem

Open a GitHub issue with enough for someone to reproduce it without a back-and-forth:

- **What you were trying to do** — the TwiML/verb or REST call involved.
- **What happened vs. what you expected** — include the adapter's output. When it can't do something, it's designed to say so and stop rather than fail silently, so paste that message if you got one.
- **A minimal repro** — the smallest TwiML snippet or request that triggers it. Scrub any real numbers, tokens, or customer data first.
- **Environment** — adapter version/commit, Node version, and whether you're hitting real Bandwidth or a test setup.

> ⚠️ **Never** paste live credentials, real customer phone numbers, recordings, or any PII into an issue or PR. Redact before you post.

## How to contribute a change

1. **Fork and branch** off `main`.
2. **Match the existing style.** The translation logic is a fixed rulebook driven by [`src/matrix/twilio-voice.json`](src/matrix/twilio-voice.json), not ad-hoc guessing. If you're adding or changing verb/attribute support, that matrix is usually where it starts — keep the "translate faithfully or fail loudly" principle intact.
3. **Add tests.** This repo leans on its test suite hard (that's how we trust it on real calls). New behavior needs coverage; changed behavior needs its tests updated.
4. **Keep the checks green** before you open the PR:

   ```bash
   npm install
   npm test          # vitest suite
   npm run typecheck  # or: npx tsc --noEmit
   ```

5. **Write a clear PR description** — what changed, why, and how you verified it. If you tested against real calls, say so; that's the highest-value signal we have.

## What makes a change easy to accept

- It keeps the adapter **honest**: correct translations, and a loud, clear failure when something isn't supported — never a silently broken call.
- It's **tested** and the suite passes.
- It's **scoped** — one focused change per PR beats a sprawling one.
- It updates the **docs** (README capability tables especially) when it changes what the adapter can do.

## What to expect on review

Review may take a while, and a maintainer might ask you to carry a change further than you expected — more tests, a doc update, a tweak to the matrix. That bar is what keeps the adapter trustworthy on live calls.

Thanks for contributing. Every solid issue and PR makes this more useful for the next person moving a voice app without rewriting it.
