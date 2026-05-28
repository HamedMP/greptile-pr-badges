export type PullRequestStatus = {
  number: number;
  headSha: string | null;
  score: number | null;
  reviewedSha: string | null;
  reviewUpdatedAt: string | null;
  latestCommitDate: string | null;
  state: GreptileState;
  summaryUrl: string | null;
  reviewCount: number | null;
  source: "github-comment" | "github-check" | "missing" | "error";
  error?: string;
};

export type GreptileState =
  | "fresh"
  | "stale"
  | "reviewing"
  | "failed"
  | "missing"
  | "unknown";

export type PullRequestRow = {
  number: number;
  element: HTMLElement;
};

export type GithubPullRequestNode = {
  number: number;
  url: string;
  headRefOid: string | null;
  latestCommitDate: string | null;
  comments: GithubIssueComment[];
  checks: GithubCheckContext[];
};

export type GithubIssueComment = {
  authorLogin: string | null;
  body: string;
  bodyText: string;
  updatedAt: string;
  createdAt: string;
  url: string;
};

export type GithubCheckContext = {
  name: string;
  appSlug: string | null;
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED" | string;
  conclusion: string | null;
};
