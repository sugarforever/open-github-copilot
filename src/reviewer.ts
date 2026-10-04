// The reviewer: one durable conversation per pull request, read-only tools, and one review per commit.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { type ModelThinkingLevel, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTool,
	type Harness,
	type ModelRef,
	section,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import type { GitHub, PullRequest } from "./github.ts";

// Which conversation reviews which pull request, kept on the root conversation.
const Conversations = defineDoc<Record<string, ConversationId>>({
	kind: "app.pull-conversations",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

// The pull request and commit a conversation is reviewing.
const Pull = defineDoc<{ number: number; sha: string }>({
	kind: "app.pull",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ number: 0, sha: "" }),
});

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const pullOf = async (api: ToolExecutionApi, context: Context) => (await api.snapshot(Pull, api.conversationId, context))!;
const marker = (sha: string) => `<!-- open-github-copilot:${sha} -->`;

export function createReviewer(github: GitHub, language: string) {
	// The built-in read tool does not declare replay, so it defaults to "unsafe". Reading is safe to repeat.
	const read = { ...createReadTool(), replay: "safe" as const };

	const diff = defineTool({
		name: "pr_diff",
		description: "Get the unified diff of the pull request under review.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) => text(await github.diff((await pullOf(api, context)).number)),
	});

	const search = defineTool({
		name: "search",
		description: "Search the repository at the pull request's commit with `git grep`. Returns path:line:text.",
		parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async ({ pattern, path }, api, context) => {
			const args = ["grep", "-n", "-I", "-e", pattern, "--", ...(path ? [path] : [])];
			const result = await promisify(execFile)("git", args, { cwd: (await api.agent(context)).cwd }).catch(
				(error) => ({ stdout: error.code === 1 ? "No matches." : String(error.message) }),
			);
			return text(result.stdout.slice(0, 20_000));
		},
	});

	// Posting is not replay-safe: a crash mid-call must not post twice. The marker makes a second call a no-op.
	const postReview = defineTool({
		name: "post_review",
		description:
			"Post the review once you are done: a summary, and inline comments on lines added or changed in the diff " +
			"(line numbers of the new file).",
		parameters: Type.Object({
			summary: Type.String(),
			comments: Type.Array(Type.Object({ path: Type.String(), line: Type.Integer(), body: Type.String() })),
		}),
		execute: async ({ summary, comments }, api, context) => {
			const { number, sha } = await pullOf(api, context);
			if ((await github.reviewBodies(number)).some((body) => body.includes(marker(sha)))) {
				return text("A review for this commit is already posted.");
			}
			const review = { commit_id: sha, event: "COMMENT" as const, body: `${summary}\n\n${marker(sha)}` };
			const url = await github
				.createReview(number, { ...review, comments: comments.map((c) => ({ ...c, side: "RIGHT" as const })) })
				// GitHub rejects the whole review when a comment is outside the diff; fold the comments into the body.
				.catch(() => {
					const list = comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join("\n");
					return github.createReview(number, { ...review, body: `${summary}\n\n${list}\n\n${marker(sha)}` });
				});
			return { ...text(`Posted: ${url}`), control: { terminate: true } };
		},
	});

	return defineExtension({
		name: "reviewer",
		tools: [diff, read, search, postReview],
		sections: [
			section(
				"role",
				() =>
					"You review pull requests. Start with pr_diff, then use read and search to check the changed code " +
					"against the rest of the repository: callers, types, and edge cases. Report only real problems " +
					"(bugs, broken callers, missing cases, security). Never edit files. When done, call post_review " +
					`exactly once. Write the review in ${language}.`,
			),
		],
	});
}

export type ReviewOptions = { model: ModelRef; thinkingLevel: ModelThinkingLevel };

/** Submit a review of `pr` at its current commit. The same commit is only ever submitted once. */
export async function enqueue(harness: Harness, pr: PullRequest, cwd: string, options: ReviewOptions, context: Context) {
	const root = await harness.root(context);
	let id = (await harness.snapshot(Conversations, root.id, context))?.[pr.number];
	if (id === undefined) {
		const created = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				init: async (tx, id) => {
					(await tx.doc(Conversations, root.id))[pr.number] = id;
				},
			},
			context,
		);
		id = created.id;
	}
	const conversation = (await harness.conversation(id, context))!;
	// Config changes and a new commit's checkout apply from the next request.
	await conversation.configure({ ...options, cwd }, context);
	await conversation.commit(async (tx) => Object.assign(await tx.doc(Pull, id), { number: pr.number, sha: pr.sha }), context);
	const submission = await conversation.submit(
		{
			type: "input",
			content: `Review pull request #${pr.number} "${pr.title}" at commit ${pr.sha}.\n\n${pr.body}`,
			requestId: `review:${pr.number}@${pr.sha}`,
			whenBusy: "steer",
		},
		context,
	);
	return { conversation, submission };
}
