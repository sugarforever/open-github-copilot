# open-github-copilot

A pull request reviewer agent built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). It watches a repository, and for every new commit on an open pull request it reads the diff, checks the change against the rest of the code, and posts a review with inline comments.

Because it runs on Pi Durable, a review survives a crash: restart the process and it continues where it stopped, without reviewing the same commit twice or posting the same review twice.

## Run

```bash
npm install
export DEEPSEEK_API_KEY=...   # or the key of the provider in config.json
npm start                     # uses GITHUB_TOKEN, or `gh auth token`
```

`config.json`:

| Field | Meaning |
|---|---|
| `repo` | `owner/name` to watch |
| `model` | any [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) provider and model, e.g. `{ "provider": "deepseek", "modelId": "deepseek-flash" }` |
| `thinkingLevel` | `off`, `low`, `medium`, `high` |
| `language` | language of the review |
| `pollSeconds` | how often to check for new commits |
| `dataDir` | the SQLite store, the clone, and one worktree per reviewed commit |

## Deploy on a server

The reviewer runs unattended in one container. Build the image and start it with your keys:

```bash
docker build -t open-github-copilot .
docker run -d --name reviewer --restart unless-stopped \
  -e GITHUB_TOKEN=... \
  -e DEEPSEEK_API_KEY=... \
  -v "$PWD/config.json:/app/config.json:ro" \
  -v reviewer-data:/app/.data \
  open-github-copilot
docker logs -f reviewer
```

- `GITHUB_TOKEN`: a fine-grained token for the repository with **Contents: read** and **Pull requests: read and write**. Reviews are posted as its owner.
- `DEEPSEEK_API_KEY`: drives the default model, `deepseek/deepseek-flash` (DeepSeek V4.1 Flash). Another provider needs its own key; the process exits at startup when the key for the configured provider is missing.
- `reviewer-data` keeps the SQLite store across restarts: after a crash, a reboot, or a new image, unfinished reviews continue and reviewed commits are not reviewed again. Run one container per volume; a store has no cross-process locking.
- Checkouts of commits that are no longer the head of an open pull request are removed on every poll.

## How it works

| File | Role |
|---|---|
| `src/main.ts` | Opens the Harness on SQLite, resumes unfinished reviews, polls open pull requests |
| `src/reviewer.ts` | The reviewer extension and `enqueue()`: one conversation per pull request, one submission per commit |
| `src/workspace.ts` | A git worktree of each commit, used as the conversation's working directory; old ones are pruned |
| `src/github.ts` | The four GitHub REST calls it needs |

- **One conversation per pull request.** Later commits go to the same conversation, so the reviewer knows what it said before.
- **One submission per commit.** The request ID is `review:<number>@<sha>`; seeing the same commit again (another poll, a restart) returns the existing submission.
- **Read-only tools.** `pr_diff`, `read`, and `search` are declared `replay: "safe"`, so they rerun after a crash. `post_review` is not: an interrupted call is never repeated, and a marker in the review body keeps a second call from posting twice.

## Test

```bash
npm test   # a scripted model against a fake GitHub, no network
```
