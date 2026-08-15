import { describe, expect, it } from "vitest";
import {
  httpClient,
  upsertStickyComment,
  type FetchLike,
  type GitHubClient,
  type GitHubComment,
} from "../src/github.ts";
import {
  InputError,
  pullRequestContext,
  readInputs,
} from "../src/inputs.ts";

const MARKER = "<!-- tidemark:report -->";
const TARGET = { owner: "quirelabs", repo: "tidemark", issueNumber: 42 };

function fakeClient(existing: GitHubComment[]) {
  const calls: string[] = [];
  const client: GitHubClient = {
    listComments: async () => existing,
    createComment: async (_target, body) => {
      calls.push(`create:${body.slice(0, 20)}`);
    },
    updateComment: async (_owner, _repo, id, body) => {
      calls.push(`update:${id}:${body.slice(0, 20)}`);
    },
  };
  return { client, calls };
}

describe("sticky comment", () => {
  it("creates when there is nothing to replace", async () => {
    const { client, calls } = fakeClient([
      { id: 1, body: "unrelated review comment" },
    ]);
    const outcome = await upsertStickyComment(client, TARGET, MARKER, `${MARKER}\nnew`);

    expect(outcome).toBe("created");
    expect(calls).toEqual(["create:<!-- tidemark:report"]);
  });

  it("replaces the previous report instead of adding another", async () => {
    const { client, calls } = fakeClient([
      { id: 1, body: "unrelated" },
      { id: 7, body: `${MARKER}\nthe old report` },
      { id: 9, body: "also unrelated" },
    ]);
    const outcome = await upsertStickyComment(client, TARGET, MARKER, `${MARKER}\nnew`);

    expect(outcome).toBe("updated");
    expect(calls).toEqual(["update:7:<!-- tidemark:report"]);
  });

  it("never posts twice across repeated runs", async () => {
    const comments: GitHubComment[] = [];
    const client: GitHubClient = {
      listComments: async () => comments,
      createComment: async (_t, body) => {
        comments.push({ id: comments.length + 1, body });
      },
      updateComment: async (_o, _r, id, body) => {
        const found = comments.find((c) => c.id === id);
        if (found) found.body = body;
      },
    };

    for (const push of ["run 1", "run 2", "run 3"]) {
      await upsertStickyComment(client, TARGET, MARKER, `${MARKER}\n${push}`);
    }

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("run 3");
  });
});

describe("http client", () => {
  it("pages through comments until the last partial page", async () => {
    const requested: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      requested.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      const body =
        page === 1
          ? Array.from({ length: 100 }, (_, i) => ({ id: i, body: "x" }))
          : [{ id: 999, body: `${MARKER} here` }];
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => body,
      };
    };

    const client = httpClient("token", "https://api.github.com", fetchImpl);
    const comments = await client.listComments(TARGET);

    expect(comments).toHaveLength(101);
    expect(requested).toHaveLength(2);
  });

  it("surfaces an API failure rather than silently skipping the comment", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 403,
      text: async () => "Resource not accessible by integration",
      json: async () => ({}),
    });

    const client = httpClient("token", "https://api.github.com", fetchImpl);
    await expect(client.listComments(TARGET)).rejects.toThrow(/403/);
    await expect(client.listComments(TARGET)).rejects.toThrow(/not accessible/);
  });

  it("sends the token as a bearer header", async () => {
    let seen: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = init?.headers;
      return { ok: true, status: 200, text: async () => "", json: async () => [] };
    };

    await httpClient("secret-token", "https://api.github.com", fetchImpl).listComments(
      TARGET,
    );
    expect(seen?.["authorization"]).toBe("Bearer secret-token");
  });
});

describe("inputs", () => {
  it("reads GitHub style environment variables", () => {
    const inputs = readInputs({
      INPUT_CONNECTION: "postgres://localhost/db",
      "INPUT_FAIL-ON": "danger",
      INPUT_RUN: "pnpm migrate",
      "INPUT_WORKING-DIRECTORY": "/repo",
      "INPUT_GITHUB-TOKEN": "tok",
    });

    expect(inputs.connection).toBe("postgres://localhost/db");
    expect(inputs.failOn).toBe("danger");
    expect(inputs.run).toBe("pnpm migrate");
    expect(inputs.workingDirectory).toBe("/repo");
    expect(inputs.token).toBe("tok");
    expect(inputs.comment).toBe(true);
  });

  it("falls back to DATABASE_URL", () => {
    expect(readInputs({ DATABASE_URL: "postgres://fallback" }).connection).toBe(
      "postgres://fallback",
    );
  });

  it("insists on a connection", () => {
    expect(() => readInputs({})).toThrow(InputError);
  });

  it("rejects a bad fail-on rather than silently ignoring it", () => {
    expect(() =>
      readInputs({ DATABASE_URL: "x", "INPUT_FAIL-ON": "yes-please" }),
    ).toThrow(/must be one of/);
  });

  it("treats blank inputs as absent, which is how GitHub sends them", () => {
    const inputs = readInputs({ DATABASE_URL: "x", INPUT_RUN: "   " });
    expect(inputs.run).toBeNull();
  });
});

describe("pull request context", () => {
  const env = { GITHUB_REPOSITORY: "quirelabs/tidemark" };

  it("reads the number from a pull_request payload", () => {
    expect(pullRequestContext(env, { pull_request: { number: 42 } })).toEqual(TARGET);
  });

  it("reads the number from an issue_comment style payload", () => {
    expect(pullRequestContext(env, { number: 42 })).toEqual(TARGET);
  });

  it("returns null off a pull request", () => {
    expect(pullRequestContext(env, { push: true })).toBeNull();
    expect(pullRequestContext(env, null)).toBeNull();
  });

  it("refuses a non numeric number rather than building a bad URL", () => {
    // The payload is attacker influenced on some events, so it is validated
    // rather than trusted, and it never reaches a shell either way.
    expect(pullRequestContext(env, { number: "42; rm -rf /" })).toBeNull();
    expect(pullRequestContext(env, { number: -1 })).toBeNull();
    expect(pullRequestContext(env, { pull_request: { number: {} } })).toBeNull();
  });

  it("returns null without a repository", () => {
    expect(pullRequestContext({}, { number: 42 })).toBeNull();
  });
});
