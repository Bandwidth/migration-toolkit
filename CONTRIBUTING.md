# Contributing

First off — thanks for being here. If you're reading this, you're either using the adapter or thinking about improving it, and either way we're glad you showed up.

Before anything else, one honest note about what this project is and isn't.

## The deal (please read this first)

**bw-voice-adapter is a best-effort, community-supported project — not a fully supported Bandwidth product.**

There's no team staffed on this full-time. It was built to solve a real problem well, and it's proven on real calls, but nobody is on the hook for a support SLA, a release schedule, or a guaranteed response time. We want to be upfront about that so your expectations and ours line up from day one.

What that means in practice:

- **Open an issue or put up a PR — genuinely, please do.** That's exactly how this project stays useful. A Bandmate will take a look when they're able to.
- **Response times will vary.** Could be a day, could be longer, depending on what else is on people's plates. It's not indifference — it's just that this isn't anyone's dedicated job.
- **No promises on prioritization.** We can't commit to fixing a given bug or shipping a given feature on any particular timeline. If something is blocking you, the fastest path is often a PR you drive yourself, with us helping review.

If you need guaranteed, SLA-backed support for a production voice migration, that's a conversation to have with your Bandwidth account team — not this repo.

None of this is meant to wave you off. Best-effort still means real effort. We'd just rather tell you the truth than let you find it out the hard way.

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

## A realistic word on review

Because this is best-effort, review may take a while, and a maintainer might ask you to carry a change further than you expected — more tests, a doc update, a tweak to the matrix. It's not us being precious; it's the bar that keeps this thing trustworthy on live calls. Thanks in advance for your patience with that.

Seriously — thank you for contributing. Every good issue and every solid PR makes this more useful for the next person trying to move a voice app without rewriting it.
