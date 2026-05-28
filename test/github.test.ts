import { describe, expect, it } from "vitest";
import { buildPullRequestQuery, normalizePullRequestNodes } from "../src/github";

describe("buildPullRequestQuery", () => {
  it("aliases each pull request in one GraphQL query", () => {
    const query = buildPullRequestQuery([12, 34]);
    expect(query).toContain("pr12: pullRequest(number: 12)");
    expect(query).toContain("pr34: pullRequest(number: 34)");
    expect(query).toContain("statusCheckRollup");
    expect(query).toContain("checkSuite");
    expect(query).toContain("contexts(first: 20)");
    expect(query).toContain("comments(last: 12)");
  });
});

describe("normalizePullRequestNodes", () => {
  it("normalizes comments, latest commit, and checks", () => {
    const nodes = normalizePullRequestNodes({
      pr7: {
        number: 7,
        url: "https://github.com/owner/repo/pull/7",
        headRefOid: "abc123",
        commits: {
          nodes: [{
            commit: {
              oid: "abc123",
              committedDate: "2026-05-28T12:00:00Z",
              statusCheckRollup: {
                contexts: {
                  nodes: [{
                    __typename: "CheckRun",
                    name: "Greptile Code Review",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                    checkSuite: {
                      app: {
                        slug: "greptile",
                        name: "Greptile",
                      },
                    },
                  }],
                },
              },
            },
          }],
        },
        comments: {
          nodes: [{
            author: { login: "greptileai" },
            body: "Confidence Score 5/5",
            bodyText: "Confidence Score 5/5",
            createdAt: "2026-05-28T12:01:00Z",
            updatedAt: "2026-05-28T12:02:00Z",
            url: "https://github.com/owner/repo/pull/7#issuecomment-1",
          }],
        },
      },
    });

    expect(nodes).toEqual([{
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      headRefOid: "abc123",
      latestCommitDate: "2026-05-28T12:00:00Z",
      comments: [{
        authorLogin: "greptileai",
        body: "Confidence Score 5/5",
        bodyText: "Confidence Score 5/5",
        createdAt: "2026-05-28T12:01:00Z",
        updatedAt: "2026-05-28T12:02:00Z",
        url: "https://github.com/owner/repo/pull/7#issuecomment-1",
      }],
      checks: [{
        name: "Greptile Code Review",
        appSlug: "greptile",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      }],
    }]);
  });
});
