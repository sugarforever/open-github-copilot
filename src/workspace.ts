// A read-only checkout of each pull request commit: one clone, one git worktree per commit.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { PullRequest } from "./github.ts";

const git = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd });

export async function checkout(dataDir: string, repo: string, pr: PullRequest): Promise<string> {
	await mkdir(dataDir, { recursive: true });
	const clone = resolve(dataDir, "repo");
	if (!existsSync(clone)) await git(dataDir, "clone", "--quiet", `https://github.com/${repo}.git`, "repo");

	const worktree = resolve(dataDir, "worktrees", `pr-${pr.number}-${pr.sha.slice(0, 7)}`);
	if (!existsSync(worktree)) {
		await git(clone, "fetch", "--quiet", "origin", `pull/${pr.number}/head`);
		await git(clone, "worktree", "add", "--detach", "--force", worktree, pr.sha);
	}
	return worktree;
}
