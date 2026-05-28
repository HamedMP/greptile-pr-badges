import type { ChromeLike, ChromeRuntimeMessage, ExtensionSettings } from "./chrome";
import type { PullRequestRow, PullRequestStatus } from "./types";

const chromeApi = getContentChrome();
const STYLE_ID = "greptile-pr-badges-style";
const BADGE_CLASS = "greptile-pr-badge";
const SCAN_DEBOUNCE_MS = 160;
const PR_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/pulls(?:$|[/?#])/;
const ROW_LINK_PATTERN = /\/pull\/(\d+)(?:$|[/?#])/;

let scanTimer: number | undefined;
let lastSignature = "";
let settings: ExtensionSettings | null = null;

void boot();

async function boot(): Promise<void> {
  injectStyles();
  settings = await requestSettings();
  scheduleScan();

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  document.addEventListener("turbo:render", scheduleScan);
  document.addEventListener("pjax:end", scheduleScan);
}

function scheduleScan(): void {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    void scanPullRequestList();
  }, SCAN_DEBOUNCE_MS);
}

async function scanPullRequestList(): Promise<void> {
  const repo = parseRepoLocation(location.pathname);
  if (!repo || !chromeApi?.runtime.sendMessage) {
    return;
  }

  const rows = collectPullRequestRows();
  if (rows.length === 0) {
    return;
  }

  const signature = `${repo.owner}/${repo.repo}:${rows.map((row) => row.number).join(",")}`;
  if (signature === lastSignature && rows.every((row) => row.element.querySelector(`.${BADGE_CLASS}`))) {
    return;
  }
  lastSignature = signature;

  for (const row of rows) {
    ensureBadge(row).textContent = "Greptile ...";
  }

  const response = await sendMessage({
    type: "greptile-pr-badges:get-pr-statuses",
    owner: repo.owner,
    repo: repo.repo,
    pullNumbers: rows.map((row) => row.number),
  });

  if (!isStatusResponse(response)) {
    for (const row of rows) {
      renderBadge(row, {
        number: row.number,
        headSha: null,
        score: null,
        reviewedSha: null,
        reviewUpdatedAt: null,
        latestCommitDate: null,
        state: "unknown",
        summaryUrl: null,
        reviewCount: null,
        source: "error",
        error: "extension_message_failed",
      });
    }
    return;
  }

  const byNumber = new Map(response.statuses.map((status) => [status.number, status]));
  const fallbackRows: PullRequestRow[] = [];
  for (const row of rows) {
    const status = byNumber.get(row.number);
    if (!status) {
      continue;
    }

    if (status.source === "error") {
      fallbackRows.push(row);
      continue;
    }

    if (status.state === "missing" && settings?.showMissingReviews === false) {
      row.element.querySelector(`.${BADGE_CLASS}`)?.remove();
      continue;
    }

    renderBadge(row, status);
  }

  if (fallbackRows.length > 0) {
    await renderFallbackRows(repo.owner, repo.repo, fallbackRows, byNumber);
  }
}

function collectPullRequestRows(): PullRequestRow[] {
  const seen = new Set<number>();
  const rows: PullRequestRow[] = [];
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/pull/"]'));

  for (const link of links) {
    const match = link.pathname.match(ROW_LINK_PATTERN);
    const number = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(number) || seen.has(number)) {
      continue;
    }

    const row = link.closest("[data-testid='list-row'], [id^='issue_'], .js-issue-row, .Box-row, div[role='row'], li") as HTMLElement | null;
    if (!row) {
      continue;
    }

    seen.add(number);
    rows.push({ number, element: row });
  }

  return rows.slice(0, 50);
}

function ensureBadge(row: PullRequestRow): HTMLAnchorElement {
  const existing = row.element.querySelector<HTMLAnchorElement>(`.${BADGE_CLASS}`);
  if (existing) {
    return existing;
  }

  const badge = document.createElement("a");
  badge.className = BADGE_CLASS;
  badge.href = "#";
  badge.setAttribute("aria-label", "Greptile review status");
  badge.addEventListener("click", (event) => {
    if (badge.href.endsWith("#")) {
      event.preventDefault();
    }
  });

  const metadata = row.element.querySelector<HTMLElement>(".opened-by, .f6.color-fg-muted, .color-fg-muted");
  if (metadata) {
    metadata.append(" ");
    metadata.append(badge);
    return badge;
  }

  row.element.append(badge);
  return badge;
}

function renderBadge(row: PullRequestRow, status: PullRequestStatus): void {
  const badge = ensureBadge(row);
  badge.dataset.state = status.state;
  badge.dataset.score = status.score === null ? "none" : String(status.score);
  badge.setAttribute("aria-label", formatBadgeText(status));
  badge.replaceChildren(...createBadgeContent(status));
  badge.title = formatBadgeTitle(status);
  badge.href = status.summaryUrl ?? "#";
}

function createBadgeContent(status: PullRequestStatus): HTMLElement[] {
  const tile = document.createElement("span");
  tile.className = "greptile-pr-badge__tile";
  tile.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "greptile-pr-badge__label";

  if (status.state === "reviewing") {
    label.textContent = "reviewing";
    return [tile, label];
  }

  if (status.state === "failed") {
    label.textContent = "failed";
    return [tile, label];
  }

  if (status.state === "missing") {
    label.textContent = "no review";
    return [tile, label];
  }

  if (status.source === "error") {
    label.textContent = formatErrorLabel(status.error);
    return [tile, label];
  }

  const score = document.createElement("span");
  score.className = "greptile-pr-badge__score";
  score.textContent = status.score === null ? "?/5" : `${status.score}/5`;

  if (status.state === "stale") {
    const stale = document.createElement("span");
    stale.className = "greptile-pr-badge__stale";
    stale.textContent = "stale";
    return [tile, score, stale];
  }

  label.textContent = "score";
  return [tile, label, score];
}

function formatBadgeText(status: PullRequestStatus): string {
  if (status.state === "reviewing") {
    return "Greptile reviewing";
  }

  if (status.state === "failed") {
    return "Greptile failed";
  }

  if (status.state === "missing") {
    return "No Greptile";
  }

  if (status.source === "error") {
    return formatErrorBadge(status.error);
  }

  const score = status.score === null ? "?" : String(status.score);
  return status.state === "stale" ? `Greptile ${score}/5 stale` : `Greptile ${score}/5`;
}

function formatErrorBadge(error: string | undefined): string {
  if (error === "github_token_missing") {
    return "Greptile no token";
  }

  if (error?.includes("github_graphql_401")) {
    return "Greptile auth";
  }

  if (error?.includes("API rate limit") || error?.includes("rate limit")) {
    return "Greptile rate limit";
  }

  if (error?.includes("MAX_NODE_LIMIT") || error?.includes("exceeds")) {
    return "Greptile too many";
  }

  return "Greptile unavailable";
}

function formatErrorLabel(error: string | undefined): string {
  if (error === "github_token_missing") {
    return "no token";
  }

  if (error?.includes("github_graphql_401")) {
    return "auth";
  }

  if (error?.includes("API rate limit") || error?.includes("rate limit")) {
    return "rate limit";
  }

  if (error?.includes("MAX_NODE_LIMIT") || error?.includes("exceeds")) {
    return "too many";
  }

  return "unavailable";
}

function formatBadgeTitle(status: PullRequestStatus): string {
  if (status.error) {
    return status.error;
  }

  if (status.state === "stale") {
    return "A newer commit exists after the latest Greptile summary.";
  }

  if (status.state === "reviewing") {
    return "Greptile appears to be reviewing the latest PR head.";
  }

  if (status.reviewedSha) {
    return `Last reviewed commit: ${status.reviewedSha}`;
  }

  return "Greptile review status";
}

function parseRepoLocation(pathname: string): { owner: string; repo: string } | null {
  const match = pathname.match(PR_PATH_PATTERN);
  if (!match) {
    return null;
  }

  return {
    owner: decodeURIComponent(match[1] ?? ""),
    repo: decodeURIComponent(match[2] ?? ""),
  };
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${BADGE_CLASS} {
      align-items: center;
      background: #fff8df;
      border: 1px solid #211b16;
      border-radius: 4px;
      box-shadow: 2px 2px 0 #211b16;
      color: #211b16;
      display: inline-flex;
      font-size: 11px;
      font-weight: 800;
      gap: 5px;
      line-height: 16px;
      margin-left: 6px;
      min-height: 20px;
      padding: 1px 7px 1px 4px;
      position: relative;
      text-decoration: none;
      text-transform: uppercase;
      vertical-align: middle;
      white-space: nowrap;
    }

    .${BADGE_CLASS}:hover {
      text-decoration: none;
      transform: translate(1px, 1px);
      box-shadow: 1px 1px 0 #211b16;
    }

    .greptile-pr-badge__tile {
      background:
        linear-gradient(135deg, transparent 0 34%, currentColor 35% 66%, transparent 67%),
        #c83138;
      border: 1px solid #211b16;
      clip-path: polygon(12% 0, 100% 0, 88% 100%, 0 100%);
      display: inline-block;
      height: 12px;
      width: 14px;
    }

    .greptile-pr-badge__label,
    .greptile-pr-badge__stale {
      color: rgba(33, 27, 22, 0.72);
      font-size: 9px;
      letter-spacing: 0;
    }

    .greptile-pr-badge__score {
      color: #211b16;
      font-variant-numeric: tabular-nums;
    }

    .${BADGE_CLASS}[data-state="fresh"] {
      background: #e7f8d8;
    }

    .${BADGE_CLASS}[data-state="stale"] {
      background: #e7f8d8;
    }

    .${BADGE_CLASS}[data-state="reviewing"] {
      background: #fff8df;
    }

    .${BADGE_CLASS}[data-state="reviewing"] .greptile-pr-badge__tile {
      animation: greptile-pr-badge-pulse 1.1s steps(2, jump-none) infinite;
    }

    .${BADGE_CLASS}[data-state="failed"],
    .${BADGE_CLASS}[data-state="unknown"] {
      background: #c83138;
      color: #fff8df;
    }

    .${BADGE_CLASS}[data-state="failed"] .greptile-pr-badge__label,
    .${BADGE_CLASS}[data-state="unknown"] .greptile-pr-badge__label {
      color: rgba(255, 248, 223, 0.84);
    }

    .${BADGE_CLASS}[data-state="failed"] .greptile-pr-badge__tile,
    .${BADGE_CLASS}[data-state="unknown"] .greptile-pr-badge__tile {
      background: #fff8df;
    }

    .${BADGE_CLASS}[data-state="missing"] {
      background: #f0ead1;
      color: rgba(33, 27, 22, 0.72);
    }

    .${BADGE_CLASS}[data-score="5"] {
      background: #d9f2c7;
    }

    .${BADGE_CLASS}[data-score="5"] .greptile-pr-badge__tile {
      background: #3d9b4f;
    }

    .${BADGE_CLASS}[data-score="4"] {
      background: #fff4b8;
    }

    .${BADGE_CLASS}[data-score="4"] .greptile-pr-badge__tile {
      background: #c9a227;
    }

    .${BADGE_CLASS}[data-score="3"] {
      background: #ffe0bd;
    }

    .${BADGE_CLASS}[data-score="3"] .greptile-pr-badge__tile {
      background: #df7f2f;
    }

    .${BADGE_CLASS}[data-score="0"],
    .${BADGE_CLASS}[data-score="1"],
    .${BADGE_CLASS}[data-score="2"] {
      background: #ffd1cc;
    }

    .${BADGE_CLASS}[data-score="0"] .greptile-pr-badge__tile,
    .${BADGE_CLASS}[data-score="1"] .greptile-pr-badge__tile,
    .${BADGE_CLASS}[data-score="2"] .greptile-pr-badge__tile {
      background: #c83138;
    }

    @keyframes greptile-pr-badge-pulse {
      0%, 100% { background-color: #c83138; }
      50% { background-color: #938c3d; }
    }

    @media (prefers-color-scheme: dark) {
      .${BADGE_CLASS} {
        background: #fff8df;
        border-color: #0d1117;
        box-shadow: 2px 2px 0 #0d1117;
        color: #211b16;
      }

      .${BADGE_CLASS}[data-state="fresh"] {
        background: #d9f2c7;
      }

      .${BADGE_CLASS}[data-state="stale"] {
        background: #d9f2c7;
      }

      .${BADGE_CLASS}[data-score="4"] {
        background: #fff4b8;
      }

      .${BADGE_CLASS}[data-score="3"] {
        background: #ffe0bd;
      }

      .${BADGE_CLASS}[data-score="0"],
      .${BADGE_CLASS}[data-score="1"],
      .${BADGE_CLASS}[data-score="2"] {
        background: #ffd1cc;
      }

      .${BADGE_CLASS}[data-state="reviewing"] {
        background: #fff8df;
      }

      .${BADGE_CLASS}[data-state="failed"],
      .${BADGE_CLASS}[data-state="unknown"] {
        background: #c83138;
        color: #fff8df;
      }

      .${BADGE_CLASS}[data-state="missing"] {
        background: #f0ead1;
        color: rgba(33, 27, 22, 0.72);
      }
    }
  `;
  document.head.append(style);
}

async function requestSettings(): Promise<ExtensionSettings | null> {
  const response = await sendMessage({ type: "greptile-pr-badges:get-settings" });
  if (isSettingsResponse(response)) {
    return response.settings;
  }

  return null;
}

function sendMessage(message: ChromeRuntimeMessage): Promise<unknown> {
  return new Promise((resolve) => {
    chromeApi?.runtime.sendMessage?.(message, (response) => {
      if (chromeApi.runtime.lastError) {
        resolve({ ok: false, error: chromeApi.runtime.lastError.message });
        return;
      }

      resolve(response);
    });
  });
}

function isStatusResponse(response: unknown): response is { ok: true; statuses: PullRequestStatus[] } {
  return Boolean(response && typeof response === "object" && (response as { ok?: unknown }).ok === true && Array.isArray((response as { statuses?: unknown }).statuses));
}

function isSettingsResponse(response: unknown): response is { ok: true; settings: ExtensionSettings } {
  return Boolean(response && typeof response === "object" && (response as { ok?: unknown }).ok === true && (response as { settings?: unknown }).settings);
}

function getContentChrome(): ChromeLike | null {
  const maybeChrome = globalThis as typeof globalThis & { chrome?: ChromeLike };
  return maybeChrome.chrome ?? null;
}

async function renderFallbackRows(
  owner: string,
  repo: string,
  rows: PullRequestRow[],
  byNumber: Map<number, PullRequestStatus>,
): Promise<void> {
  const fallbacks = await mapWithConcurrency(rows, 8, async (row) => ({
    row,
    status: await fetchPrPageFallback(owner, repo, row.number),
  }));

  for (const { row, status } of fallbacks) {
    renderBadge(row, status ?? byNumber.get(row.number) ?? {
      number: row.number,
      headSha: null,
      score: null,
      reviewedSha: null,
      reviewUpdatedAt: null,
      latestCommitDate: null,
      state: "unknown",
      summaryUrl: null,
      reviewCount: null,
      source: "error",
      error: "fallback_failed",
    });
  }
}

async function fetchPrPageFallback(owner: string, repo: string, number: number): Promise<PullRequestStatus | null> {
  try {
    const response = await fetch(`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${number}`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
    if (!/Greptile Summary/i.test(text)) {
      return null;
    }

    const score = parseFallbackScore(text);
    const reviewedSha = parseFallbackReviewedSha(html, text);
    const latestRequestedSha = parseLatestRequestedSha(text);
    const state = reviewedSha && latestRequestedSha && !shaMatches(reviewedSha, latestRequestedSha) ? "stale" : score === null ? "unknown" : "fresh";

    return {
      number,
      headSha: latestRequestedSha,
      score,
      reviewedSha,
      reviewUpdatedAt: null,
      latestCommitDate: null,
      state,
      summaryUrl: `/${owner}/${repo}/pull/${number}`,
      reviewCount: parseFallbackReviewCount(text),
      source: "github-comment",
    };
  } catch {
    return null;
  }
}

function parseFallbackScore(text: string): number | null {
  const match = text.match(/Confidence\s+Score:\s*([0-5])\s*\/\s*5/i) ?? text.match(/(?:^|\s)([0-5])\s*\/\s*5(?:\s|$)/i);
  if (!match) {
    return null;
  }

  const score = Number(match[1]);
  return Number.isInteger(score) && score >= 0 && score <= 5 ? score : null;
}

function parseFallbackReviewedSha(html: string, text: string): string | null {
  const footerIndex = text.search(/Last\s+reviewed\s+commit/i);
  if (footerIndex >= 0) {
    const match = text.slice(footerIndex, footerIndex + 900).match(/\b[0-9a-f]{7,40}\b/i);
    if (match?.[0]) {
      return match[0].toLowerCase();
    }
  }

  const commitMatch = html.match(/\/commit\/([0-9a-f]{7,40})/i);
  return commitMatch?.[1]?.toLowerCase() ?? null;
}

function parseLatestRequestedSha(text: string): string | null {
  const matches = [...text.matchAll(/review\s+the\s+latest\s+head\s+commit\s+([0-9a-f]{7,40})/gi)];
  const last = matches.at(-1);
  return last?.[1]?.toLowerCase() ?? null;
}

function parseFallbackReviewCount(text: string): number | null {
  const match = text.match(/Reviews?\s*\(?\s*(\d+)\s*\)?/i);
  if (!match) {
    return null;
  }

  const count = Number(match[1]);
  return Number.isInteger(count) && count > 0 ? count : null;
}

function shaMatches(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}
