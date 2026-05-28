import type { GithubCheckContext, GithubIssueComment, GreptileState } from "./types";

export type ParsedGreptileSummary = {
  score: number | null;
  reviewedSha: string | null;
  reviewCount: number | null;
  state: GreptileState;
  updatedAt: string;
  url: string;
};

const HEX_SHA_PATTERN = /\b[0-9a-f]{7,40}\b/gi;
const SCORE_PATTERNS = [
  /(?:confidence\s+score|score)\D{0,80}([0-5])\s*\/\s*5/i,
  /(?:^|\s)([0-5])\s*\/\s*5(?:\s|$)/i,
  /(?:confidence|ready(?:\s+to\s+merge)?)\D{0,80}([0-5])(?:\s*out\s*of\s*5)?/i,
];
const REVIEW_COUNT_PATTERN = /reviews?\s*\(?\s*(\d+)\s*\)?/i;

export function isGreptileAuthor(login: string | null): boolean {
  return Boolean(login && /greptile/i.test(login));
}

export function parseGreptileSummaries(comments: GithubIssueComment[]): ParsedGreptileSummary | null {
  const greptileComments = comments
    .filter((comment) => isGreptileAuthor(comment.authorLogin) || looksLikeGreptileSummary(comment))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  if (greptileComments.length === 0) {
    return null;
  }

  const comment = greptileComments[0];
  const text = `${comment.bodyText}\n${comment.body}`;

  return {
    score: parseScore(text),
    reviewedSha: parseReviewedSha(text),
    reviewCount: parseReviewCount(text),
    state: parseCommentState(text),
    updatedAt: comment.updatedAt,
    url: comment.url,
  };
}

export function parseScore(text: string): number | null {
  for (const pattern of SCORE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }

    const score = Number(match[1]);
    if (Number.isInteger(score) && score >= 0 && score <= 5) {
      return score;
    }
  }

  return null;
}

export function parseReviewedSha(text: string): string | null {
  const reviewedCommitIndex = text.search(/last\s+reviewed\s+commit/i);
  if (reviewedCommitIndex >= 0) {
    const slice = text.slice(reviewedCommitIndex, reviewedCommitIndex + 700);
    const directMatch = slice.match(HEX_SHA_PATTERN);
    if (directMatch?.[0]) {
      return directMatch[0].toLowerCase();
    }
  }

  const commitUrlMatch = text.match(/\/commit\/([0-9a-f]{7,40})/i);
  return commitUrlMatch?.[1]?.toLowerCase() ?? null;
}

export function parseReviewCount(text: string): number | null {
  const match = text.match(REVIEW_COUNT_PATTERN);
  if (!match) {
    return null;
  }

  const count = Number(match[1]);
  return Number.isInteger(count) && count > 0 ? count : null;
}

export function parseCommentState(text: string): GreptileState {
  if (/😕|failed|couldn['’]?t\s+review|error/i.test(text)) {
    return "failed";
  }

  if (/👀|analy[sz]ing|review\s+in\s+progress|reviewing/i.test(text)) {
    return "reviewing";
  }

  return "unknown";
}

export function inferReviewState(input: {
  headSha: string | null;
  latestCommitDate: string | null;
  summary: ParsedGreptileSummary | null;
  checks: GithubCheckContext[];
}): GreptileState {
  const activeCheck = input.checks.find((check) => {
    const identity = `${check.name} ${check.appSlug ?? ""}`;
    return /greptile/i.test(identity) && (check.status === "QUEUED" || check.status === "IN_PROGRESS");
  });

  if (activeCheck || input.summary?.state === "reviewing") {
    return "reviewing";
  }

  const failedCheck = input.checks.find((check) => {
    const identity = `${check.name} ${check.appSlug ?? ""}`;
    return /greptile/i.test(identity) && check.status === "COMPLETED" && check.conclusion === "FAILURE";
  });

  if (failedCheck || input.summary?.state === "failed") {
    return "failed";
  }

  if (!input.summary) {
    return "missing";
  }

  if (input.headSha && input.summary.reviewedSha) {
    return input.headSha.toLowerCase().startsWith(input.summary.reviewedSha.toLowerCase()) ||
      input.summary.reviewedSha.toLowerCase().startsWith(input.headSha.toLowerCase())
      ? "fresh"
      : "stale";
  }

  if (input.latestCommitDate && Date.parse(input.summary.updatedAt) < Date.parse(input.latestCommitDate)) {
    return "stale";
  }

  return input.summary.score === null ? "unknown" : "fresh";
}

function looksLikeGreptileSummary(comment: GithubIssueComment): boolean {
  const text = `${comment.bodyText}\n${comment.body}`;
  return /greptile/i.test(text) && /confidence\s+score|last\s+reviewed\s+commit|reviews?\s*\(/i.test(text);
}
