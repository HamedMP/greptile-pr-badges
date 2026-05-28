import { describe, expect, it } from "vitest";
import { inferReviewState, parseGreptileSummaries, parseReviewedSha, parseScore } from "../src/parser";
import type { GithubIssueComment } from "../src/types";

const baseComment: GithubIssueComment = {
  authorLogin: "greptileai",
  body: "",
  bodyText: "",
  createdAt: "2026-05-28T10:00:00Z",
  updatedAt: "2026-05-28T10:05:00Z",
  url: "https://github.com/hamedmp/example/pull/1#issuecomment-1",
};

describe("parseScore", () => {
  it("extracts confidence scores from summary text", () => {
    expect(parseScore("Confidence Score\n\n5/5")).toBe(5);
    expect(parseScore("Score: 3 / 5")).toBe(3);
    expect(parseScore("ready to merge: 4 out of 5")).toBe(4);
  });

  it("rejects values outside the Greptile score range", () => {
    expect(parseScore("Score: 9/5")).toBeNull();
  });
});

describe("parseReviewedSha", () => {
  it("extracts the SHA near the last reviewed commit footer", () => {
    expect(parseReviewedSha("Last reviewed commit: abc1234 Improve the extension")).toBe("abc1234");
  });

  it("falls back to commit URLs", () => {
    expect(parseReviewedSha("https://github.com/owner/repo/commit/1234567890abcdef")).toBe("1234567890abcdef");
  });
});

describe("parseGreptileSummaries", () => {
  it("uses the latest Greptile summary comment", () => {
    const summary = parseGreptileSummaries([
      {
        ...baseComment,
        bodyText: "Confidence Score 3/5\nLast reviewed commit: aaaaaaa\nReviews (1)",
        updatedAt: "2026-05-28T10:00:00Z",
      },
      {
        ...baseComment,
        bodyText: "Confidence Score 5/5\nLast reviewed commit: bbbbbbb\nReviews (2)",
        updatedAt: "2026-05-28T11:00:00Z",
      },
    ]);

    expect(summary).toMatchObject({
      score: 5,
      reviewedSha: "bbbbbbb",
      reviewCount: 2,
    });
  });

  it("matches Greptile's current GitHub summary and footer format", () => {
    const summary = parseGreptileSummaries([{
      ...baseComment,
      authorLogin: "greptile-apps",
      bodyText: "Greptile Summary\n\nConfidence Score: 4/5\n\nReviews (9): Last reviewed commit: \"fix(shell): guard terminal shell actions\"",
      body: '<h3>Greptile Summary</h3><h3>Confidence Score: 4/5</h3><sub>Reviews (9): Last reviewed commit: ["fix(shell): guard terminal shell actions"](https://github.com/hamedmp/matrix-os/commit/412c94823254796cb788d651a62a0f4923603dbf)</sub>',
    }]);

    expect(summary).toMatchObject({
      score: 4,
      reviewedSha: "412c94823254796cb788d651a62a0f4923603dbf",
      reviewCount: 9,
    });
  });
});

describe("inferReviewState", () => {
  it("marks a matching reviewed SHA as fresh", () => {
    expect(inferReviewState({
      headSha: "abc123456789",
      latestCommitDate: "2026-05-28T10:00:00Z",
      summary: {
        score: 5,
        reviewedSha: "abc1234",
        reviewCount: 1,
        state: "unknown",
        updatedAt: "2026-05-28T10:05:00Z",
        url: "https://example.com",
      },
      checks: [],
    })).toBe("fresh");
  });

  it("marks a changed head SHA as stale", () => {
    expect(inferReviewState({
      headSha: "def567856789",
      latestCommitDate: "2026-05-28T10:00:00Z",
      summary: {
        score: 5,
        reviewedSha: "abc1234",
        reviewCount: 1,
        state: "unknown",
        updatedAt: "2026-05-28T10:05:00Z",
        url: "https://example.com",
      },
      checks: [],
    })).toBe("stale");
  });

  it("prioritizes active Greptile check runs", () => {
    expect(inferReviewState({
      headSha: "def567856789",
      latestCommitDate: "2026-05-28T10:00:00Z",
      summary: null,
      checks: [{
        name: "Greptile Code Review",
        appSlug: "greptile",
        status: "IN_PROGRESS",
        conclusion: null,
      }],
    })).toBe("reviewing");
  });
});
