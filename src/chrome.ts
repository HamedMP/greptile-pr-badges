export type ChromeRuntimeMessage =
  | {
      type: "greptile-pr-badges:get-pr-statuses";
      owner: string;
      repo: string;
      pullNumbers: number[];
    }
  | {
      type: "greptile-pr-badges:get-settings";
    }
  | {
      type: "greptile-pr-badges:save-settings";
      settings: ExtensionSettings;
    }
  | {
      type: "greptile-pr-badges:test-github-token";
    };

export type ExtensionSettings = {
  githubToken: string;
  cacheTtlMs: number;
  batchSize: number;
  showMissingReviews: boolean;
};

export type ChromeLike = {
  runtime: {
    sendMessage?: (
      message: ChromeRuntimeMessage,
      callback?: (response: unknown) => void
    ) => void;
    onMessage?: {
      addListener: (
        callback: (
          message: ChromeRuntimeMessage,
          sender: unknown,
          sendResponse: (response: unknown) => void
        ) => boolean | void
      ) => void;
    };
    lastError?: { message?: string };
    openOptionsPage?: () => void;
    getManifest?: () => { options_page?: string };
    getURL?: (path: string) => string;
  };
  tabs?: {
    create?: (properties: { url: string }) => void;
  };
  action?: {
    onClicked?: {
      addListener: (callback: () => void) => void;
    };
  };
  storage: {
    local: ChromeStorageArea;
    session?: ChromeStorageArea;
  };
};

export type ChromeStorageArea = {
  get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove?: (keys: string | string[]) => Promise<void>;
};

export const defaultSettings: ExtensionSettings = {
  githubToken: "",
  cacheTtlMs: 5 * 60 * 1000,
  batchSize: 8,
  showMissingReviews: true,
};

export function getChrome(): ChromeLike | null {
  const maybeChrome = globalThis as typeof globalThis & { chrome?: ChromeLike };
  return maybeChrome.chrome ?? null;
}
