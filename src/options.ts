import type { ChromeLike, ChromeRuntimeMessage, ExtensionSettings } from "./chrome";
import "./settings.css";

const defaultSettings: ExtensionSettings = {
  githubToken: "",
  cacheTtlMs: 5 * 60 * 1000,
  batchSize: 8,
  showMissingReviews: true,
};
const chromeApi = getOptionsChrome();

const form = document.querySelector<HTMLFormElement>("#settings-form");
const tokenInput = document.querySelector<HTMLInputElement>("#github-token");
const cacheTtlSelect = document.querySelector<HTMLSelectElement>("#cache-ttl");
const batchSizeInput = document.querySelector<HTMLInputElement>("#batch-size");
const showMissingInput = document.querySelector<HTMLInputElement>("#show-missing");
const testTokenButton = document.querySelector<HTMLButtonElement>("#test-token");
const status = document.querySelector<HTMLParagraphElement>("#status");

void hydrate();

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});

testTokenButton?.addEventListener("click", () => {
  void testToken();
});

async function hydrate(): Promise<void> {
  const response = await sendMessage({ type: "greptile-pr-badges:get-settings" });
  const settings = isSettingsResponse(response) ? response.settings : defaultSettings;

  if (tokenInput) {
    tokenInput.value = settings.githubToken;
  }
  if (cacheTtlSelect) {
    cacheTtlSelect.value = String(settings.cacheTtlMs);
  }
  if (batchSizeInput) {
    batchSizeInput.value = String(settings.batchSize);
  }
  if (showMissingInput) {
    showMissingInput.checked = settings.showMissingReviews;
  }
}

async function save(): Promise<void> {
  const settings: ExtensionSettings = {
    githubToken: tokenInput?.value ?? "",
    cacheTtlMs: Number(cacheTtlSelect?.value ?? defaultSettings.cacheTtlMs),
    batchSize: Number(batchSizeInput?.value ?? defaultSettings.batchSize),
    showMissingReviews: Boolean(showMissingInput?.checked),
  };

  const response = await sendMessage({
    type: "greptile-pr-badges:save-settings",
    settings,
  });

  if (status) {
    status.textContent = isSettingsResponse(response) ? "Saved." : "Unable to save settings.";
  }
}

async function testToken(): Promise<void> {
  await save();
  const response = await sendMessage({ type: "greptile-pr-badges:test-github-token" });

  if (!status) {
    return;
  }

  if (isTokenTestResponse(response)) {
    status.textContent = `GraphQL OK: @${response.login}, ${response.remaining ?? "unknown"} requests left.`;
    return;
  }

  status.textContent = `GraphQL failed: ${readError(response)}`;
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

function isSettingsResponse(response: unknown): response is { ok: true; settings: ExtensionSettings } {
  return Boolean(response && typeof response === "object" && (response as { ok?: unknown }).ok === true && (response as { settings?: unknown }).settings);
}

function isTokenTestResponse(response: unknown): response is { ok: true; login: string; remaining: number | null } {
  return Boolean(response && typeof response === "object" && (response as { ok?: unknown }).ok === true && typeof (response as { login?: unknown }).login === "string");
}

function readError(response: unknown): string {
  if (response && typeof response === "object" && typeof (response as { error?: unknown }).error === "string") {
    return (response as { error: string }).error;
  }

  return "unknown_error";
}

function getOptionsChrome(): ChromeLike | null {
  const maybeChrome = globalThis as typeof globalThis & { chrome?: ChromeLike };
  return maybeChrome.chrome ?? null;
}
