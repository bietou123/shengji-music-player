import { create } from "zustand";
import { api, errorMessage } from "./api";
import type {
  LibrarySnapshot,
  SearchKind,
  SearchResult,
  SourceId,
  SourceStatus,
  Track,
} from "../shared/types";

export type View =
  | "discover"
  | "library"
  | "favorites"
  | "recent"
  | "playlists"
  | "downloads"
  | "settings"
  | "search"
  | `playlist:${string}`;
export type SearchStatus = Omit<SourceStatus, "status"> & {
  status: SourceStatus["status"] | "loading";
};
interface Toast {
  id: number;
  message: string;
  tone: "success" | "error" | "info";
}
interface AppStore {
  snapshot: LibrarySnapshot | null;
  ready: boolean;
  bootError: string;
  view: View;
  query: string;
  searchKind: SearchKind;
  searchTracks: Track[];
  searchStatuses: SearchStatus[];
  searchLoading: boolean;
  lastQuery: string;
  discovery: SearchResult | null;
  discoveryLoading: boolean;
  importing: boolean;
  importProgress: { done: number; total: number } | null;
  queueVisible: boolean;
  toast: Toast | null;
  refresh(): Promise<LibrarySnapshot>;
  search(query?: string, kind?: SearchKind): Promise<void>;
  retrySource(source: SourceId): Promise<void>;
  discover(): Promise<void>;
  importMusic(
    mode: "files" | "folder" | "scan" | "paths",
    paths?: string[],
  ): Promise<void>;
  notify(message: string, tone?: Toast["tone"]): void;
}

let searchEpoch = 0;
let discoveryEpoch = 0;
let toastTimer: ReturnType<typeof setTimeout>;

export const useApp = create<AppStore>((set, get) => ({
  snapshot: null,
  ready: false,
  bootError: "",
  view: "discover",
  query: "",
  searchKind: "song",
  searchTracks: [],
  searchStatuses: [],
  searchLoading: false,
  lastQuery: "",
  discovery: null,
  discoveryLoading: false,
  importing: false,
  importProgress: null,
  queueVisible: true,
  toast: null,
  async refresh() {
    try {
      const snapshot = await api.bootstrap();
      set({ snapshot, ready: true, bootError: "" });
      return snapshot;
    } catch (error) {
      set({ ready: true, bootError: errorMessage(error) });
      throw error;
    }
  },
  async search(input, inputKind) {
    const query = (input ?? get().query).trim();
    if (!query) {
      set({ view: "search" });
      return;
    }
    if (query.length > 150) {
      get().notify("搜索内容不能超过 150 个字符", "error");
      return;
    }
    const kind = inputKind ?? get().searchKind;
    const epoch = ++searchEpoch;
    const enabled =
      get().snapshot?.sources.filter(
        (source) => source.enabled && source.configured,
      ) ?? [];
    set({
      view: "search",
      query,
      lastQuery: query,
      searchKind: kind,
      searchTracks: [],
      searchStatuses: enabled.map((source) => ({
        source: source.id,
        status: "loading",
        count: 0,
      })),
      searchLoading: enabled.length > 0,
    });
    const snapshot = get().snapshot;
    if (snapshot)
      set({
        snapshot: {
          ...snapshot,
          searchHistory: [
            query,
            ...snapshot.searchHistory.filter((item) => item !== query),
          ].slice(0, 12),
        },
      });
    if (!enabled.length) {
      try {
        await api.search({ query, kind, sources: [] });
      } catch (error) {
        get().notify(errorMessage(error), "error");
      }
      return;
    }
    await Promise.all(
      enabled.map(async (descriptor) => {
        try {
          const result = await api.search({
            query,
            kind,
            sources: [descriptor.id],
          });
          if (epoch !== searchEpoch) return;
          set((state) => ({
            searchTracks: [...state.searchTracks, ...result.tracks],
            searchStatuses: state.searchStatuses.map((status) =>
              status.source === descriptor.id ? result.statuses[0] : status,
            ),
          }));
        } catch (error) {
          if (epoch === searchEpoch)
            set((state) => ({
              searchStatuses: state.searchStatuses.map((status) =>
                status.source === descriptor.id
                  ? {
                      source: descriptor.id,
                      status: "error",
                      count: 0,
                      error: errorMessage(error),
                    }
                  : status,
              ),
            }));
        }
      }),
    );
    if (epoch === searchEpoch) set({ searchLoading: false });
  },
  async retrySource(source) {
    const { lastQuery: query, searchKind: kind } = get();
    if (!query) return;
    const epoch = searchEpoch;
    set((state) => ({
      searchStatuses: state.searchStatuses.map((status) =>
        status.source === source
          ? { source, status: "loading", count: 0 }
          : status,
      ),
    }));
    try {
      const result = await api.search({ query, kind, sources: [source] });
      if (epoch === searchEpoch)
        set((state) => ({
          searchTracks: [
            ...state.searchTracks.filter((track) => track.source !== source),
            ...result.tracks,
          ],
          searchStatuses: state.searchStatuses.map((status) =>
            status.source === source ? result.statuses[0] : status,
          ),
        }));
    } catch (error) {
      if (epoch === searchEpoch)
        set((state) => ({
          searchStatuses: state.searchStatuses.map((status) =>
            status.source === source
              ? {
                  source,
                  status: "error",
                  count: 0,
                  error: errorMessage(error),
                }
              : status,
          ),
        }));
    }
  },
  async discover() {
    const epoch = ++discoveryEpoch;
    set({ discoveryLoading: true });
    try {
      const result = await api.discover();
      if (epoch === discoveryEpoch)
        set({ discovery: result, discoveryLoading: false });
    } catch (error) {
      if (epoch === discoveryEpoch) {
        set({ discoveryLoading: false });
        get().notify(errorMessage(error), "error");
      }
    }
  },
  async importMusic(mode, paths) {
    if (get().importing) return;
    set({ importing: true, importProgress: null });
    try {
      const result =
        mode === "files"
          ? await api.importFiles()
          : mode === "folder"
            ? await api.importFolder()
            : mode === "scan"
              ? await api.rescanFolders()
              : await api.importPaths(paths ?? []);
      await get().refresh();
      if (result.imported) {
        set({ view: "library" });
        get().notify(
          `已导入 ${result.imported} 首${result.skipped ? `，跳过 ${result.skipped} 个文件` : ""}`,
        );
      } else if (result.errors.length)
        get().notify(result.errors.join("；"), "error");
      else if (mode === "paths" || mode === "scan")
        get().notify("没有找到可导入的音频", "info");
    } catch (error) {
      get().notify(errorMessage(error), "error");
    } finally {
      set({ importing: false, importProgress: null });
    }
  },
  notify(message, tone = "success") {
    clearTimeout(toastTimer);
    set({ toast: { id: Date.now(), message, tone } });
    toastTimer = setTimeout(
      () => set({ toast: null }),
      tone === "error" ? 6500 : 3500,
    );
  },
}));

export async function act(
  action: () => Promise<unknown>,
  success?: string,
): Promise<boolean> {
  try {
    await action();
    if (success) useApp.getState().notify(success);
    return true;
  } catch (error) {
    useApp.getState().notify(errorMessage(error), "error");
    return false;
  }
}
