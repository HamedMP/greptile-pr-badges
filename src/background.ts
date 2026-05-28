import { defaultSettings, getChrome, type ChromeRuntimeMessage, type ExtensionSettings } from "./chrome";
import { fetchPullRequestNodes } from "./github";
import { inferReviewState, parseGreptileSummaries } from "./parser";
import type { GithubPullRequestNode, PullRequestStatus } from "./types";

const SETTINGS_KEY = "greptile-pr-badges:settings";
const CACHE_PREFIX = "greptile-pr-badges:cache:v2:";
const chromeApi = getChrome();

if (chromeApi?.runtime.onMessage) {
  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      });

    return true;
  });
}

chromeApi?.action?.onClicked?.addListener(() => {
  if (chromeApi.runtime.openOptionsPage) {
    chromeApi.runtime.openOptionsPage();
    return;
  }

  const optionsPath = chromeApi.runtime.getManifest?.().options_page ?? "options.html";
  const optionsUrl = chromeApi.runtime.getURL?.(optionsPath) ?? optionsPath;
  chromeApi.tabs?.create?.({ url: optionsUrl });
});

async function handleMessage(message: ChromeRuntimeMessage): Promise<unknown> {
  if (message.type === "greptile-pr-badges:get-settings") {
    return { ok: true, settings: await loadSettings() };
  }

  if (message.type === "greptile-pr-badges:save-settings") {
    await saveSettings(message.settings);
    return { ok: true, settings: await loadSettings() };
  }

  if (message.type === "greptile-pr-badges:test-github-token") {
    return testGithubToken(await loadSettings());
  }

  if (message.type === "greptile-pr-badges:get-pr-statuses") {
    const settings = await loadSettings();
    if (!settings.githubToken.trim()) {
      return {
        ok: true,
        statuses: message.pullNumbers.map((number) => ({
          ...missingStatus(number),
          state: "unknown",
          source: "error",
          error: "github_token_missing",
        })),
      };
    }
    const statuses = await getPullRequestStatuses({
      owner: message.owner,
      repo: message.repo,
      pullNumbers: message.pullNumbers,
      settings,
    });

    return { ok: true, statuses };
  }

  return { ok: false, error: "unknown_message" };
}

async function testGithubToken(settings: ExtensionSettings): Promise<unknown> {
  if (!settings.githubToken.trim()) {
    return { ok: false, error: "github_token_missing" };
  }

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${settings.githubToken.trim()}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      query: `query GreptilePrBadgesTokenTest {
        viewer { login }
        rateLimit { remaining resetAt }
      }`,
    }),
  });

  if (!response.ok) {
    return { ok: false, error: `github_graphql_${response.status}` };
  }

  const payload = await response.json() as {
    data?: { viewer?: { login?: string }; rateLimit?: { remaining?: number; resetAt?: string } };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    return { ok: false, error: payload.errors[0]?.message ?? "github_graphql_error" };
  }

  return {
    ok: true,
    login: payload.data?.viewer?.login ?? "unknown",
    remaining: payload.data?.rateLimit?.remaining ?? null,
    resetAt: payload.data?.rateLimit?.resetAt ?? null,
  };
}

async function getPullRequestStatuses(input: {
  owner: string;
  repo: string;
  pullNumbers: number[];
  settings: ExtensionSettings;
}): Promise<PullRequestStatus[]> {
  const uniquePullNumbers = [...new Set(input.pullNumbers)].filter((number) => Number.isInteger(number) && number > 0);
  const batches = chunk(uniquePullNumbers, clamp(input.settings.batchSize, 2, 12));
  const statuses: PullRequestStatus[] = [];

  for (const batch of batches) {
    const cachedByNumber = await readListCache(input.owner, input.repo, batch, input.settings.cacheTtlMs);
    const missing = batch.filter((number) => !cachedByNumber.has(number));
    statuses.push(...cachedByNumber.values());

    if (missing.length === 0) {
      continue;
    }

    try {
      const nodes = await fetchPullRequestNodes({
        owner: input.owner,
        repo: input.repo,
        pullNumbers: missing,
        settings: input.settings,
      });
      const freshStatuses = nodes.map(toPullRequestStatus);
      await writeListCache(input.owner, input.repo, freshStatuses);
      statuses.push(...freshStatuses);

      const resolved = new Set(nodes.map((node) => node.number));
      for (const number of missing) {
        if (!resolved.has(number)) {
          statuses.push(missingStatus(number));
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "github_request_failed";
      statuses.push(...missing.map((number) => ({
        ...missingStatus(number),
        state: "unknown" as const,
        source: "error" as const,
        error: message,
      })));
    }
  }

  return uniquePullNumbers.flatMap((number) => {
    const status = statuses.find((candidate) => candidate.number === number);
    return status ? [status] : [];
  });
}

function toPullRequestStatus(node: GithubPullRequestNode): PullRequestStatus {
  const summary = parseGreptileSummaries(node.comments);
  const state = inferReviewState({
    headSha: node.headRefOid,
    latestCommitDate: node.latestCommitDate,
    summary,
    checks: node.checks,
  });

  return {
    number: node.number,
    headSha: node.headRefOid,
    score: summary?.score ?? null,
    reviewedSha: summary?.reviewedSha ?? null,
    reviewUpdatedAt: summary?.updatedAt ?? null,
    latestCommitDate: node.latestCommitDate,
    state,
    summaryUrl: summary?.url ?? null,
    reviewCount: summary?.reviewCount ?? null,
    source: summary ? "github-comment" : state === "reviewing" || state === "failed" ? "github-check" : "missing",
  };
}

function missingStatus(number: number): PullRequestStatus {
  return {
    number,
    headSha: null,
    score: null,
    reviewedSha: null,
    reviewUpdatedAt: null,
    latestCommitDate: null,
    state: "missing",
    summaryUrl: null,
    reviewCount: null,
    source: "missing",
  };
}

async function loadSettings(): Promise<ExtensionSettings> {
  if (!chromeApi) {
    return defaultSettings;
  }

  const stored = await chromeApi.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  const cacheTtlMs = value?.cacheTtlMs;
  const batchSize = value?.batchSize;
  return {
    githubToken: typeof value?.githubToken === "string" ? value.githubToken : defaultSettings.githubToken,
    cacheTtlMs: Number.isFinite(cacheTtlMs) ? clamp(Number(cacheTtlMs), 30_000, 60 * 60 * 1000) : defaultSettings.cacheTtlMs,
    batchSize: Number.isFinite(batchSize) ? clamp(Number(batchSize), 2, 12) : defaultSettings.batchSize,
    showMissingReviews: typeof value?.showMissingReviews === "boolean" ? value.showMissingReviews : defaultSettings.showMissingReviews,
  };
}

async function saveSettings(settings: ExtensionSettings): Promise<void> {
  if (!chromeApi) {
    return;
  }

  await chromeApi.storage.local.set({
    [SETTINGS_KEY]: {
      githubToken: settings.githubToken.trim(),
      cacheTtlMs: clamp(Number(settings.cacheTtlMs), 30_000, 60 * 60 * 1000),
      batchSize: clamp(Number(settings.batchSize), 2, 12),
      showMissingReviews: Boolean(settings.showMissingReviews),
    },
  });
}

async function readListCache(owner: string, repo: string, pullNumbers: number[], ttlMs: number): Promise<Map<number, PullRequestStatus>> {
  const storage = chromeApi?.storage.session ?? chromeApi?.storage.local;
  if (!storage) {
    return new Map();
  }

  const keys = pullNumbers.map((number) => cacheKey(owner, repo, number));
  const values = await storage.get(keys);
  const now = Date.now();
  const result = new Map<number, PullRequestStatus>();

  for (const key of keys) {
    const entry = values[key] as { storedAt?: number; status?: PullRequestStatus } | undefined;
    if (!entry?.storedAt || !entry.status || now - entry.storedAt > ttlMs) {
      continue;
    }

    result.set(entry.status.number, entry.status);
  }

  return result;
}

async function writeListCache(owner: string, repo: string, statuses: PullRequestStatus[]): Promise<void> {
  const storage = chromeApi?.storage.session ?? chromeApi?.storage.local;
  if (!storage || statuses.length === 0) {
    return;
  }

  const storedAt = Date.now();
  const entries = Object.fromEntries(statuses.map((status) => [
    cacheKey(owner, repo, status.number),
    { storedAt, status },
  ]));

  await storage.set(entries);
}

function cacheKey(owner: string, repo: string, pullNumber: number): string {
  return `${CACHE_PREFIX}${owner}/${repo}#${pullNumber}`;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
