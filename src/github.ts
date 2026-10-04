// The few GitHub REST calls the reviewer needs.

export type PullRequest = { number: number; title: string; body: string; sha: string; labels: string[] };

export type Review = {
	commit_id: string;
	event: "COMMENT";
	body: string;
	comments?: { path: string; line: number; side: "RIGHT"; body: string }[];
};

export type GitHub = {
	openPullRequests(): Promise<PullRequest[]>;
	diff(number: number): Promise<string>;
	reviewBodies(number: number): Promise<string[]>;
	createReview(number: number, review: Review): Promise<string>;
};

export function createGitHub(repo: string, token: string): GitHub {
	const call = async (path: string, init: RequestInit = {}, accept = "application/vnd.github+json") => {
		const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, accept, "x-github-api-version": "2022-11-28" },
		});
		if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
		return accept.endsWith("diff") ? response.text() : response.json();
	};

	return {
		async openPullRequests() {
			const pulls = await call("/pulls?state=open&per_page=50");
			return pulls
				.filter((pull: any) => !pull.draft)
				.map((pull: any) => ({
					number: pull.number,
					title: pull.title,
					body: pull.body ?? "",
					sha: pull.head.sha,
					labels: pull.labels,
				}));
		},
		diff: (number) => call(`/pulls/${number}`, {}, "application/vnd.github.diff"),
		async reviewBodies(number) {
			return (await call(`/pulls/${number}/reviews?per_page=100`)).map((review: any) => review.body ?? "");
		},
		async createReview(number, review) {
			return (await call(`/pulls/${number}/reviews`, { method: "POST", body: JSON.stringify(review) })).html_url;
		},
	};
}
