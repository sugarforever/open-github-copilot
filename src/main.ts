// Watch a repository's pull requests and review each new commit.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type ConversationId, createRegistry, Harness, UsageDoc, watchEvents } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createGitHub, type PullRequest } from "./github.ts";
import { createReviewer, enqueue } from "./reviewer.ts";
import { checkout } from "./workspace.ts";

const config = JSON.parse(readFileSync(process.argv[2] ?? "config.json", "utf8"));
const context = BACKGROUND_CONTEXT;
const token = process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const github = createGitHub(config.repo, token);

mkdirSync(config.dataDir, { recursive: true });
const registry = createRegistry();
registry.install(createReviewer(github, config.language));
const harness = await Harness.open(
	await openNodeSqliteStorage(join(config.dataDir, "reviews.sqlite")),
	{ models: builtinModels(), registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
	context,
);
process.on("SIGINT", () => harness.close(context).then(() => process.exit(0)));

const log = (pr: number | string, message: string) =>
	console.log(`${new Date().toTimeString().slice(0, 8)}  ${String(pr).padEnd(6)} ${message}`);

// Print each review's tool calls as they are committed.
const followed = new Set<ConversationId>();
async function follow(id: ConversationId, pr: number) {
	if (followed.has(id)) return;
	followed.add(id);
	(await watchEvents(harness, id, context)).start(async (events) => {
		for (const event of events) {
			if (event.type !== "tool_execution_start") continue;
			const args = Object.values(event.args).filter((value) => typeof value === "string").join(" ");
			log(`#${pr}`, `${event.toolName} ${event.toolName === "post_review" ? "" : args}`.slice(0, 100));
		}
	});
}

async function review(pr: PullRequest) {
	const cwd = await checkout(config.dataDir, config.repo, pr);
	const options = { model: config.model, thinkingLevel: config.thinkingLevel };
	const { conversation, submission } = await enqueue(harness, pr, cwd, options, context);
	await follow(conversation.id, pr.number);
	if ((await submission.status(context)).status === "done") return log(`#${pr.number}`, `${pr.sha.slice(0, 7)} already reviewed`);
	log(`#${pr.number}`, `review ${pr.sha.slice(0, 7)} "${pr.title}" (submission ${submission.id})`);

	void submission.wait(context).then(async (settled) => {
		const usage = Object.values((await harness.snapshot(UsageDoc, conversation.id, context))?.models ?? {});
		const cost = usage.reduce((sum, each) => sum + each.cost.total, 0);
		log(`#${pr.number}`, `${settled.status} · ${config.model.provider}/${config.model.modelId} · $${cost.toFixed(4)} so far`);
	});
}

log("watch", `${config.repo} every ${config.pollSeconds}s with ${config.model.provider}/${config.model.modelId}`);
harness.resume(); // continue reviews a previous process left unfinished
const reviewed = new Map<number, string>();
for (;;) {
	try {
		for (const pr of await github.openPullRequests()) {
			if (reviewed.get(pr.number) === pr.sha) continue;
			if (config.skipLabels?.some((label: string) => pr.labels.includes(label))) continue; // opt out with a label
			await review(pr);
			reviewed.set(pr.number, pr.sha);
		}
	} catch (error) {
		log("error", error instanceof Error ? error.message : String(error));
	}
	await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
}
