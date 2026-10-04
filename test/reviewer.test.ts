// A scripted model reviews a pull request against a fake GitHub: one review per commit, one conversation per PR.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { GitHub, Review } from "../src/github.ts";
import { createReviewer, enqueue } from "../src/reviewer.ts";

test("reviews each commit once, in one conversation per pull request", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "review-"));
	await writeFile(join(cwd, "user.ts"), "export const name = (user) => user.name;\n");

	const posted: Review[] = [];
	const github: GitHub = {
		openPullRequests: async () => [],
		diff: async () => "+export const name = (user) => user.name;",
		reviewBodies: async () => posted.map((review) => review.body),
		createReview: async (_number, review) => (posted.push(review), `https://github.com/r/pull/1#${posted.length}`),
	};

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	const reviewOnce = [
		call("pr_diff", {}),
		call("read", { path: "user.ts" }),
		call("post_review", { summary: "One issue.", comments: [{ path: "user.ts", line: 1, body: "user may be null" }] }),
	];
	faux.setResponses([...reviewOnce, ...reviewOnce]);

	const registry = createRegistry();
	registry.install(createReviewer(github, "English"));
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir ?? cwd }) },
		context,
	);
	const options = { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" as const };
	const pr = { number: 1, title: "Add name", body: "", sha: "aaaaaaa", labels: [] };

	const first = await enqueue(harness, pr, cwd, options, context);
	assert.equal((await first.submission.wait(context)).status, "done");
	assert.equal(posted.length, 1);
	assert.equal(posted[0]!.comments?.[0]?.side, "RIGHT");
	assert.match(posted[0]!.body, /open-github-copilot:aaaaaaa/);

	// The same commit seen again (another poll, a restart): the same submission, no second review.
	const again = await enqueue(harness, pr, cwd, options, context);
	assert.equal(again.submission.id, first.submission.id);
	assert.equal(posted.length, 1);

	// A new commit: a second review in the same conversation.
	const next = await enqueue(harness, { ...pr, sha: "bbbbbbb" }, cwd, options, context);
	assert.equal((await next.submission.wait(context)).status, "done");
	assert.equal(next.conversation.id, first.conversation.id);
	assert.equal(posted.length, 2);

	await harness.close(context);
});
