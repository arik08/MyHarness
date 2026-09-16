---
name: grill-me
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

In MyHarness, deliver every round through the `ask_user_question` tool's `questions` array. Give each decision a unique `id`, its own `question` and `choices`; put your recommended option first and mark its label. The UI provides direct text input automatically. Do not print the interview questions in ordinary assistant text or call an unavailable question tool.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), use available tools to find it; don't ask the user for anything you could look up yourself. If independent sub-agent exploration is available and appropriate, you may delegate it. A running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the result; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

Source: [Matt Pocock's grill-me](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me), which delegates to [grilling](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling). The grilling instructions are included directly here for MyHarness, with tool-based exploration supported when sub-agents are unavailable. Distributed under the included MIT license.
