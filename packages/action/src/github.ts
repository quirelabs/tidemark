/**
 * The smallest GitHub client that can maintain one comment. Node has fetch, and
 * the REST calls we need are three, so a dependency would cost more than it
 * saves.
 */

export interface GitHubComment {
  id: number;
  body: string;
}

export interface CommentTarget {
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface GitHubClient {
  listComments: (target: CommentTarget) => Promise<GitHubComment[]>;
  createComment: (target: CommentTarget, body: string) => Promise<void>;
  updateComment: (
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ) => Promise<void>;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

const PAGE_SIZE = 100;

export function httpClient(
  token: string,
  apiUrl = "https://api.github.com",
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): GitHubClient {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };

  async function send(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API ${method} ${url} failed with ${response.status}: ${await response.text()}`,
      );
    }
    return await response.json();
  }

  return {
    listComments: async (target) => {
      const comments: GitHubComment[] = [];
      for (let page = 1; ; page++) {
        const url = `${apiUrl}/repos/${target.owner}/${target.repo}/issues/${target.issueNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`;
        const batch = (await send(url, "GET")) as GitHubComment[];
        comments.push(...batch);
        if (batch.length < PAGE_SIZE) return comments;
      }
    },

    createComment: async (target, body) => {
      await send(
        `${apiUrl}/repos/${target.owner}/${target.repo}/issues/${target.issueNumber}/comments`,
        "POST",
        { body },
      );
    },

    updateComment: async (owner, repo, commentId, body) => {
      await send(
        `${apiUrl}/repos/${owner}/${repo}/issues/comments/${commentId}`,
        "PATCH",
        { body },
      );
    },
  };
}

/**
 * Finds the previous report by its hidden marker and replaces it, so a pull
 * request with twenty pushes has one comment rather than twenty. Falls back to
 * creating when there is nothing to replace.
 */
export async function upsertStickyComment(
  client: GitHubClient,
  target: CommentTarget,
  marker: string,
  body: string,
): Promise<"created" | "updated"> {
  const comments = await client.listComments(target);
  const existing = comments.find((comment) => comment.body.includes(marker));

  if (existing === undefined) {
    await client.createComment(target, body);
    return "created";
  }

  await client.updateComment(target.owner, target.repo, existing.id, body);
  return "updated";
}
