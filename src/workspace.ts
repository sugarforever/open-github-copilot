// A read-only checkout of each pull request commit: one clone, one git worktree per commit.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PullRequest } from "./github.ts";

export function createWorkspace(dataDir: string, repo: string, token: string) {
	// The token reaches git through the environment, so private repositories work on a server without `gh`.
	const env = {
		...process.env,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
	};
	const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd, env });
	const clone = resolve(dataDir, "repo");
	const worktrees = resolve(dataDir, "worktrees");
	const nameOf = (pr: PullRequest) => `pr-${pr.number}-${pr.sha.slice(0, 7)}`;

	return {
		async checkout(pr: PullRequest): Promise<string> {
			await mkdir(dataDir, { recursive: true });
			if (!existsSync(clone)) await git(dataDir, "clone", "--quiet", `https://github.com/${repo}.git`, "repo");
			const worktree = resolve(worktrees, nameOf(pr));
			if (!existsSync(worktree)) {
				await git(clone, "fetch", "--quiet", "origin", `pull/${pr.number}/head`);
				await git(clone, "worktree", "add", "--detach", "--force", worktree, pr.sha);
			}
			return worktree;
		},
		/** Remove the checkouts of commits that are no longer the head of an open pull request. */
		async prune(open: PullRequest[]): Promise<void> {
			if (!existsSync(worktrees)) return;
			const keep = new Set(open.map(nameOf));
			for (const name of await readdir(worktrees)) {
				if (!keep.has(name)) await git(clone, "worktree", "remove", "--force", resolve(worktrees, name));
			}
		},
	};
}
