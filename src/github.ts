import type { ExtensionSettings } from "./chrome";
import type { GithubCheckContext, GithubIssueComment, GithubPullRequestNode } from "./types";

type GraphqlPullRequestResponse = {
  data?: {
    repository?: Record<string, unknown>;
  };
  errors?: Array<{ message: string }>;
};

export function buildPullRequestQuery(pullNumbers: number[]): string {
  const aliases = pullNumbers.map((number) => {
    const alias = `pr${number}`;
    return `${alias}: pullRequest(number: ${number}) {
      number
      url
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            committedDate
            statusCheckRollup {
              contexts(first: 20) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    checkSuite {
                      app {
                        slug
                        name
                      }
                    }
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
      comments(last: 12) {
        nodes {
          author {
            login
          }
          body
          bodyText
          updatedAt
          createdAt
          url
        }
      }
    }`;
  });

  return `query GreptilePrBadges($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      ${aliases.join("\n")}
    }
  }`;
}

export async function fetchPullRequestNodes(input: {
  owner: string;
  repo: string;
  pullNumbers: number[];
  settings: ExtensionSettings;
}): Promise<GithubPullRequestNode[]> {
  const headers: Record<string, string> = {
    "accept": "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };

  if (input.settings.githubToken.trim()) {
    headers.authorization = `Bearer ${input.settings.githubToken.trim()}`;
  }

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      query: buildPullRequestQuery(input.pullNumbers),
      variables: {
        owner: input.owner,
        repo: input.repo,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`github_graphql_${response.status}`);
  }

  const payload = (await response.json()) as GraphqlPullRequestResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message ?? "github_graphql_error");
  }

  return normalizePullRequestNodes(payload.data?.repository);
}

export function normalizePullRequestNodes(repository: Record<string, unknown> | undefined | null): GithubPullRequestNode[] {
  if (!repository) {
    return [];
  }

  return Object.values(repository)
    .map((value) => normalizePullRequestNode(value))
    .filter((value): value is GithubPullRequestNode => value !== null);
}

function normalizePullRequestNode(value: unknown): GithubPullRequestNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const node = value as Record<string, unknown>;
  const number = typeof node.number === "number" ? node.number : null;
  if (!number) {
    return null;
  }

  const latestCommit = readLatestCommit(node);

  return {
    number,
    url: typeof node.url === "string" ? node.url : "",
    headRefOid: typeof node.headRefOid === "string" ? node.headRefOid : latestCommit?.oid ?? null,
    latestCommitDate: latestCommit?.committedDate ?? null,
    comments: normalizeComments(node.comments),
    checks: normalizeChecks(latestCommit?.statusCheckRollup),
  };
}

function readLatestCommit(node: Record<string, unknown>): { oid: string | null; committedDate: string | null; statusCheckRollup: unknown } | null {
  const commits = node.commits as { nodes?: Array<{ commit?: Record<string, unknown> }> } | undefined;
  const commit = commits?.nodes?.[0]?.commit;
  if (!commit) {
    return null;
  }

  return {
    oid: typeof commit.oid === "string" ? commit.oid : null,
    committedDate: typeof commit.committedDate === "string" ? commit.committedDate : null,
    statusCheckRollup: commit.statusCheckRollup,
  };
}

function normalizeComments(value: unknown): GithubIssueComment[] {
  const comments = value as { nodes?: Array<Record<string, unknown>> } | undefined;
  return (comments?.nodes ?? []).flatMap((comment) => {
    const author = comment.author as { login?: unknown } | null | undefined;
    if (typeof comment.updatedAt !== "string" || typeof comment.createdAt !== "string") {
      return [];
    }

    return [{
      authorLogin: typeof author?.login === "string" ? author.login : null,
      body: typeof comment.body === "string" ? comment.body : "",
      bodyText: typeof comment.bodyText === "string" ? comment.bodyText : "",
      updatedAt: comment.updatedAt,
      createdAt: comment.createdAt,
      url: typeof comment.url === "string" ? comment.url : "",
    }];
  });
}

function normalizeChecks(value: unknown): GithubCheckContext[] {
  const rollup = value as { contexts?: { nodes?: Array<Record<string, unknown>> } } | undefined;
  return (rollup?.contexts?.nodes ?? []).flatMap((context) => {
    if (context.__typename === "CheckRun") {
      const checkSuite = context.checkSuite as { app?: { slug?: unknown } | null } | null | undefined;
      const app = checkSuite?.app;
      return [{
        name: typeof context.name === "string" ? context.name : "",
        appSlug: typeof app?.slug === "string" ? app.slug : null,
        status: typeof context.status === "string" ? context.status : "UNKNOWN",
        conclusion: typeof context.conclusion === "string" ? context.conclusion : null,
      }];
    }

    if (context.__typename === "StatusContext") {
      return [{
        name: typeof context.context === "string" ? context.context : "",
        appSlug: null,
        status: context.state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: typeof context.state === "string" ? context.state : null,
      }];
    }

    return [];
  });
}
