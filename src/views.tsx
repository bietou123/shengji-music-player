import { useEffect, useMemo, useState } from "react";
import { version } from "../package.json";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  FolderOpen,
  Grid2X2,
  Heart,
  List,
  ListPlus,
  LoaderCircle,
  Music2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shuffle,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import {
  formatTime,
  groupTracks,
  playable,
  SOURCE_NAMES,
} from "../shared/catalog";
import type { SearchKind, Settings, SourceId, Track } from "../shared/types";
import { api } from "./api";
import { act, useApp, type SearchStatus } from "./store";
import { player } from "./player";
import {
  Button,
  ConfirmModal,
  Cover,
  Dropdown,
  EmptyState,
  IconButton,
  MenuItem,
  PlaylistNameModal,
  Skeleton,
  TrackTable,
} from "./components";

export interface AlbumGroup {
  key: string;
  name: string;
  artist: string;
  tracks: Track[];
}
function albumsOf(tracks: Track[]): AlbumGroup[] {
  const albums = new Map<string, AlbumGroup>();
  for (const track of tracks) {
    const key = `${track.artist.toLowerCase()}|${track.album.toLowerCase()}`;
    const album = albums.get(key) ?? {
      key,
      name: track.album || "未命名专辑",
      artist: track.artist,
      tracks: [],
    };
    album.tracks.push(track);
    albums.set(key, album);
  }
  return [...albums.values()];
}

export function ViewHeading({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="view-heading">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

function StatusStrip({
  statuses,
  onRetry,
}: {
  statuses: SearchStatus[];
  onRetry?(source: SourceId): void;
}) {
  if (!statuses.length) return null;
  return (
    <div className="source-statuses" aria-live="polite">
      {statuses.map((status) => (
        <div key={status.source} className={`source-status ${status.status}`}>
          {status.status === "loading" ? (
            <LoaderCircle className="spin" size={13} />
          ) : (
            <span className="status-dot" />
          )}
          <span>{SOURCE_NAMES[status.source]}</span>
          <span className="muted">
            {status.status === "loading"
              ? "搜索中"
              : status.status === "ok"
                ? `${status.count} 首`
                : status.status === "disabled"
                  ? "未启用"
                  : status.error || "连接失败"}
          </span>
          {status.status === "error" && onRetry && (
            <IconButton
              icon={RefreshCw}
              label={`重试 ${SOURCE_NAMES[status.source]}`}
              onClick={() => onRetry(status.source)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function AlbumGrid({
  tracks,
  onOpen,
}: {
  tracks: Track[];
  onOpen(album: AlbumGroup): void;
}) {
  const albums = useMemo(() => albumsOf(tracks), [tracks]);
  return (
    <div className="album-grid">
      {albums.map((album) => (
        <article className="album-tile" key={album.key}>
          <div className="album-image">
            <button
              className="album-open"
              title={album.name}
              onClick={() => onOpen(album)}
            >
              <Cover
                track={
                  album.tracks.find((track) => track.artwork) ?? album.tracks[0]
                }
              />
            </button>
            <IconButton
              className="album-play"
              icon={Play}
              label={`播放专辑 ${album.name}`}
              disabled={!album.tracks.some(playable)}
              onClick={() => player.playAll(album.tracks)}
            />
          </div>
          <button
            className="album-name"
            onClick={() => onOpen(album)}
            title={album.name}
          >
            {album.name}
          </button>
          <p title={album.artist}>{album.artist}</p>
          <small>{album.tracks.length} 首</small>
        </article>
      ))}
    </div>
  );
}

export function AlbumView({
  album,
  onBack,
  onAddPlaylist,
}: {
  album: AlbumGroup;
  onBack(): void;
  onAddPlaylist(tracks: Track[]): void;
}) {
  const groups = groupTracks(album.tracks);
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} />
        返回
      </button>
      <div className="collection-heading">
        <Cover
          track={album.tracks.find((track) => track.artwork) ?? album.tracks[0]}
          size={120}
          eager
        />
        <div>
          <span className="eyebrow">专辑</span>
          <h1>{album.name}</h1>
          <p>
            {album.artist} · {groups.length} 首 ·{" "}
            {formatTime(
              groups.reduce((sum, group) => sum + group.track.duration, 0),
            )}
          </p>
          <div className="collection-actions">
            <Button
              variant="primary"
              icon={Play}
              onClick={() => player.playAll(groups.map((group) => group.track))}
            >
              播放
            </Button>
            <Button
              icon={ListPlus}
              onClick={() => onAddPlaylist(groups.map((group) => group.track))}
            >
              加入歌单
            </Button>
          </div>
        </div>
      </div>
      <TrackTable groups={groups} onAddPlaylist={onAddPlaylist} />
    </>
  );
}

export function DiscoverView({
  onOpenAlbum,
  onAddPlaylist,
}: {
  onOpenAlbum(album: AlbumGroup): void;
  onAddPlaylist(tracks: Track[]): void;
}) {
  const { discovery, discoveryLoading, discover, search } = useApp();
  const groups = useMemo(
    () => groupTracks(discovery?.tracks ?? []),
    [discovery],
  );
  return (
    <>
      <ViewHeading
        title="发现音乐"
        subtitle="专辑与作品"
        actions={
          <IconButton
            icon={RefreshCw}
            label="刷新发现音乐"
            disabled={discoveryLoading}
            className={discoveryLoading ? "spin" : ""}
            onClick={() => {
              void discover();
            }}
          />
        }
      />
      <div className="discovery-genres">
        {["纯音乐", "爵士", "古典", "华语", "现场"].map((query) => (
          <button
            key={query}
            onClick={() => {
              void search(query);
            }}
          >
            {query}
            <ArrowUpRight size={12} />
          </button>
        ))}
      </div>
      <StatusStrip
        statuses={discovery?.statuses ?? []}
        onRetry={() => {
          void discover();
        }}
      />
      {discoveryLoading && !discovery ? (
        <Skeleton grid />
      ) : groups.length ? (
        <>
          <AlbumGrid
            tracks={groups.map((group) => group.track)}
            onOpen={onOpenAlbum}
          />
          <div className="section-heading">
            <h2>音乐</h2>
            <Button
              variant="text"
              icon={Play}
              onClick={() => player.playAll(groups.map((group) => group.track))}
            >
              播放全部
            </Button>
          </div>
          <TrackTable
            groups={groups.slice(0, 18)}
            onAddPlaylist={onAddPlaylist}
          />
        </>
      ) : (
        <EmptyState
          title={discoveryLoading ? "正在加载音乐" : "暂时没有可用结果"}
          action={
            <Button
              icon={RefreshCw}
              onClick={() => {
                void discover();
              }}
            >
              重新加载
            </Button>
          }
        />
      )}
    </>
  );
}

export function SearchView({
  onOpenAlbum,
  onAddPlaylist,
}: {
  onOpenAlbum(album: AlbumGroup): void;
  onAddPlaylist(tracks: Track[]): void;
}) {
  const {
    snapshot,
    lastQuery,
    query,
    searchKind,
    searchTracks,
    searchStatuses,
    searchLoading,
    search,
    retrySource,
  } = useApp();
  const [source, setSource] = useState<SourceId | "all">("all");
  const [sort, setSort] = useState("relevance");
  const [onlyPlayable, setOnlyPlayable] = useState(false);
  useEffect(() => setSource("all"), [lastQuery]);
  const groups = useMemo(() => {
    let result = groupTracks(
      searchTracks.filter(
        (track) =>
          (source === "all" || track.source === source) &&
          (!onlyPlayable || track.availability === "full" || track.availability === "preview"),
      ),
    );
    if (sort === "title")
      result = result.sort((a, b) =>
        a.track.title.localeCompare(b.track.title, "zh-CN"),
      );
    if (sort === "artist")
      result = result.sort((a, b) =>
        a.track.artist.localeCompare(b.track.artist, "zh-CN"),
      );
    if (sort === "duration")
      result = result.sort((a, b) => a.track.duration - b.track.duration);
    if (sort === "full")
      result = result.sort(
        (a, b) =>
          Number(b.track.availability === "full") -
          Number(a.track.availability === "full"),
      );
    return result;
  }, [searchTracks, source, onlyPlayable, sort]);
  const tabs: { id: SearchKind; name: string }[] = [
    { id: "song", name: "歌曲" },
    { id: "artist", name: "歌手" },
    { id: "album", name: "专辑" },
  ];
  return (
    <>
      <ViewHeading
        title={lastQuery ? `搜索：${lastQuery}` : "搜索音乐"}
        subtitle={lastQuery ? `${groups.length} 个结果` : undefined}
      />
      <div className="search-kind-tabs" role="tablist" aria-label="搜索类型">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={searchKind === tab.id}
            className={searchKind === tab.id ? "selected" : ""}
            onClick={() => {
              useApp.setState({ searchKind: tab.id });
              if (lastQuery || query.trim())
                void search(lastQuery || query, tab.id);
            }}
          >
            {tab.name}
          </button>
        ))}
      </div>
      {!lastQuery ? (
        <>
          {snapshot?.searchHistory.length ? (
            <div className="history-section">
              <div className="section-heading">
                <h2>最近搜索</h2>
                <IconButton
                  icon={Trash2}
                  label="清空搜索历史"
                  onClick={() => {
                    void act(async () => {
                      await api.clearSearchHistory();
                      await useApp.getState().refresh();
                    });
                  }}
                />
              </div>
              <div className="history-items">
                {snapshot.searchHistory.map((item) => (
                  <button
                    key={item}
                    onClick={() => {
                      void search(item);
                    }}
                  >
                    <Search size={13} />
                    <span>{item}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState icon={Search} title="搜索歌曲、歌手或专辑" />
          )}
        </>
      ) : (
        <>
          <div className="list-toolbar">
            <label className="select-wrap">
              <select
                aria-label="音源筛选"
                value={source}
                onChange={(event) =>
                  setSource(event.target.value as SourceId | "all")
                }
              >
                <option value="all">全部音源</option>
                {snapshot?.sources
                  .filter((item) => item.enabled && item.configured)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={onlyPlayable}
                onChange={(event) => setOnlyPlayable(event.target.checked)}
              />
              可在线播放
            </label>
            <label className="select-wrap sort-select">
              <select
                aria-label="搜索排序"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="relevance">相关度</option>
                <option value="full">完整播放优先</option>
                <option value="title">歌曲名</option>
                <option value="artist">歌手</option>
                <option value="duration">时长</option>
              </select>
              <ChevronDown size={14} />
            </label>
          </div>
          <StatusStrip
            statuses={searchStatuses}
            onRetry={(id) => {
              void retrySource(id);
            }}
          />
          {searchLoading && !groups.length ? (
            <Skeleton />
          ) : groups.length ? (
            searchKind === "album" ? (
              <AlbumGrid
                tracks={groups.map((group) => group.track)}
                onOpen={onOpenAlbum}
              />
            ) : (
              <TrackTable groups={groups} onAddPlaylist={onAddPlaylist} />
            )
          ) : (
            <EmptyState
              icon={Search}
              title={
                snapshot?.sources.some(
                  (item) => item.enabled && item.configured,
                )
                  ? searchStatuses.some((status) => status.status === "error")
                    ? "音源暂不可用"
                    : "没有找到匹配的音乐"
                  : "没有已启用的音源"
              }
              action={
                <Button
                  icon={
                    snapshot?.sources.some((item) => item.enabled)
                      ? RefreshCw
                      : Settings2
                  }
                  onClick={() =>
                    snapshot?.sources.some((item) => item.enabled)
                      ? void search(lastQuery)
                      : useApp.setState({ view: "settings" })
                  }
                >
                  {snapshot?.sources.some((item) => item.enabled)
                    ? "重新搜索"
                    : "音源设置"}
                </Button>
              }
            />
          )}
        </>
      )}
    </>
  );
}

export function LibraryView({
  type,
  onOpenAlbum,
  onAddPlaylist,
}: {
  type: "library" | "favorites" | "recent";
  onOpenAlbum(album: AlbumGroup): void;
  onAddPlaylist(tracks: Track[]): void;
}) {
  const { snapshot, importing, importMusic } = useApp();
  const [display, setDisplay] = useState("tracks");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("default");
  useEffect(() => {
    setFilter("");
    setSort("default");
  }, [type]);
  const tracks =
    (type === "library"
      ? snapshot?.localTracks
      : type === "favorites"
        ? snapshot?.favorites
        : snapshot?.recent) ?? [];
  const filtered = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase();
    const result = tracks.filter(
      (track) =>
        !q ||
        `${track.title} ${track.artist} ${track.album}`
          .toLocaleLowerCase()
          .includes(q),
    );
    if (sort === "title")
      result.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    if (sort === "artist")
      result.sort((a, b) => a.artist.localeCompare(b.artist, "zh-CN"));
    if (sort === "duration") result.sort((a, b) => a.duration - b.duration);
    return result;
  }, [tracks, filter, sort]);
  const title =
    type === "library"
      ? "本地音乐"
      : type === "favorites"
        ? "我的收藏"
        : "最近播放";
  return (
    <>
      <ViewHeading
        title={title}
        subtitle={`${tracks.length} 首 · ${formatTime(tracks.reduce((sum, track) => sum + track.duration, 0))}`}
        actions={
          type === "library" ? (
            <>
              <Button
                icon={Upload}
                disabled={importing}
                onClick={() => {
                  void importMusic("files");
                }}
              >
                导入音乐
              </Button>
              <Dropdown label="更多导入选项">
                <MenuItem
                  icon={FolderOpen}
                  disabled={importing}
                  onClick={() => {
                    void importMusic("folder");
                  }}
                >
                  导入文件夹
                </MenuItem>
                <MenuItem
                  icon={RefreshCw}
                  disabled={importing || !snapshot?.folders.length}
                  onClick={() => {
                    void importMusic("scan");
                  }}
                >
                  重新扫描目录
                </MenuItem>
              </Dropdown>
            </>
          ) : undefined
        }
      />
      {!tracks.length ? (
        <EmptyState
          icon={type === "favorites" ? Heart : Music2}
          title={
            type === "library"
              ? "还没有本地音乐"
              : type === "favorites"
                ? "还没有收藏的音乐"
                : "还没有播放记录"
          }
          action={
            type === "library" ? (
              <Button
                variant="primary"
                icon={FolderOpen}
                disabled={importing}
                onClick={() => {
                  void importMusic("folder");
                }}
              >
                选择音乐文件夹
              </Button>
            ) : (
              <Button
                icon={Search}
                onClick={() => useApp.setState({ view: "search" })}
              >
                搜索音乐
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="list-toolbar">
            <Button
              variant="primary"
              icon={Play}
              disabled={!filtered.some(playable)}
              onClick={() => player.playAll(filtered)}
            >
              播放全部
            </Button>
            <IconButton
              icon={Shuffle}
              label="随机播放全部"
              disabled={!filtered.some(playable)}
              onClick={() => player.playAll(filtered, true)}
            />
            <div className="local-filter">
              <Search size={14} />
              <input
                aria-label={`筛选${title}`}
                placeholder="筛选音乐"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            <label className="select-wrap sort-select">
              <select
                aria-label="资料库排序"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="default">
                  {type === "recent" ? "最近播放" : "最近添加"}
                </option>
                <option value="title">歌曲名</option>
                <option value="artist">歌手</option>
                <option value="duration">时长</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <div className="segmented icon-segmented">
              <IconButton
                icon={List}
                label="歌曲列表"
                active={display === "tracks"}
                onClick={() => setDisplay("tracks")}
              />
              <IconButton
                icon={Grid2X2}
                label="专辑网格"
                active={display === "albums"}
                onClick={() => setDisplay("albums")}
              />
            </div>
          </div>
          {display === "albums" && filtered.length ? (
            <AlbumGrid tracks={filtered} onOpen={onOpenAlbum} />
          ) : (
            <TrackTable
              groups={filtered.map((track) => ({
                track,
                alternatives: [track],
              }))}
              onAddPlaylist={onAddPlaylist}
              emptyTitle="没有匹配的音乐"
            />
          )}
        </>
      )}
    </>
  );
}

export function PlaylistsView({ onCreate }: { onCreate(): void }) {
  const playlists = useApp((state) => state.snapshot!.playlists);
  return (
    <>
      <ViewHeading
        title="我的歌单"
        subtitle={`${playlists.length} 个歌单`}
        actions={
          <Button variant="primary" icon={Plus} onClick={onCreate}>
            新建歌单
          </Button>
        }
      />
      {playlists.length ? (
        <div className="album-grid">
          {playlists.map((playlist) => (
            <article key={playlist.id} className="album-tile">
              <div className="album-image">
                <button
                  className="album-open"
                  title={playlist.name}
                  onClick={() =>
                    useApp.setState({ view: `playlist:${playlist.id}` })
                  }
                >
                  <Cover track={playlist.tracks[0]} />
                </button>
                <IconButton
                  className="album-play"
                  icon={Play}
                  label={`播放歌单 ${playlist.name}`}
                  disabled={!playlist.tracks.some(playable)}
                  onClick={() => player.playAll(playlist.tracks)}
                />
              </div>
              <button
                className="album-name"
                title={playlist.name}
                onClick={() =>
                  useApp.setState({ view: `playlist:${playlist.id}` })
                }
              >
                {playlist.name}
              </button>
              <p>{playlist.tracks.length} 首</p>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={ListPlus}
          title="还没有歌单"
          action={
            <Button icon={Plus} variant="primary" onClick={onCreate}>
              新建歌单
            </Button>
          }
        />
      )}
    </>
  );
}

export function PlaylistView({
  id,
  onAddPlaylist,
}: {
  id: string;
  onAddPlaylist(tracks: Track[]): void;
}) {
  const playlist = useApp((state) =>
    state.snapshot!.playlists.find((item) => item.id === id),
  );
  const [rename, setRename] = useState(false);
  const [remove, setRemove] = useState(false);
  if (!playlist)
    return (
      <EmptyState
        title="歌单已被删除"
        action={
          <Button onClick={() => useApp.setState({ view: "playlists" })}>
            返回歌单
          </Button>
        }
      />
    );
  return (
    <>
      <div className="collection-heading">
        <Cover track={playlist.tracks[0]} size={120} eager />
        <div>
          <span className="eyebrow">歌单</span>
          <h1>{playlist.name}</h1>
          <p>
            {playlist.tracks.length} 首 ·{" "}
            {formatTime(
              playlist.tracks.reduce((sum, track) => sum + track.duration, 0),
            )}
          </p>
          <div className="collection-actions">
            <Button
              variant="primary"
              icon={Play}
              disabled={!playlist.tracks.some(playable)}
              onClick={() => player.playAll(playlist.tracks)}
            >
              播放全部
            </Button>
            <IconButton
              icon={Shuffle}
              label="随机播放歌单"
              disabled={!playlist.tracks.some(playable)}
              onClick={() => player.playAll(playlist.tracks, true)}
            />
            <Dropdown label="编辑歌单">
              <MenuItem icon={Pencil} onClick={() => setRename(true)}>
                重命名
              </MenuItem>
              <MenuItem icon={Trash2} danger onClick={() => setRemove(true)}>
                删除歌单
              </MenuItem>
            </Dropdown>
          </div>
        </div>
      </div>
      <TrackTable
        groups={playlist.tracks.map((track) => ({
          track,
          alternatives: [track],
        }))}
        playlistId={id}
        onAddPlaylist={onAddPlaylist}
        onReorder={(from, to) => {
          const ids = playlist.tracks.map((track) => track.id);
          ids.splice(to, 0, ids.splice(from, 1)[0]);
          void act(async () => {
            await api.reorderPlaylist(id, ids);
            await useApp.getState().refresh();
          });
        }}
        emptyTitle="歌单里还没有音乐"
      />
      {rename && (
        <PlaylistNameModal
          id={id}
          initial={playlist.name}
          onClose={() => setRename(false)}
        />
      )}
      {remove && (
        <ConfirmModal
          title="删除歌单"
          message={`删除「${playlist.name}」？音频文件和收藏不会被删除。`}
          onClose={() => setRemove(false)}
          onConfirm={async () => {
            await api.deletePlaylist(id);
            await useApp.getState().refresh();
            useApp.setState({ view: "playlists" });
          }}
        />
      )}
    </>
  );
}

export function DownloadsView() {
  const downloads = useApp((state) => state.snapshot!.downloads);
  return (
    <>
      <ViewHeading title="下载" subtitle={`${downloads.length} 个文件`} />
      {downloads.length ? (
        <div className="download-list">
          {downloads.map((record) => (
            <div key={record.id} className="download-row">
              <ArrowDownToLine size={22} />
              <div>
                <strong>{record.title}</strong>
                <span>{record.artist}</span>
                <small title={record.path}>{record.path}</small>
              </div>
              <time>{new Date(record.date).toLocaleDateString("zh-CN")}</time>
              <IconButton
                icon={FolderOpen}
                label={`显示下载文件 ${record.title}`}
                onClick={() => {
                  void act(() => api.revealDownload(record.id));
                }}
              />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={ArrowDownToLine} title="暂无下载" />
      )}
    </>
  );
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(value: boolean): void;
}) {
  return (
    <label className={`switch ${disabled ? "disabled" : ""}`} title={label}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span />
    </label>
  );
}

export function SettingsView() {
  const snapshot = useApp((state) => state.snapshot!);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const settings = snapshot.settings;
  const save = async (partial: Partial<Settings>) => {
    setBusy(true);
    await act(async () => {
      await api.saveSettings({
        ...useApp.getState().snapshot!.settings,
        ...partial,
      });
      await useApp.getState().refresh();
    });
    setBusy(false);
  };
  const sourceEnabled = (id: SourceId, value: boolean) => {
    void save({
      enabledSources: value
        ? [...settings.enabledSources, id]
        : settings.enabledSources.filter((source) => source !== id),
    });
  };
  return (
    <>
      <ViewHeading title="设置" />
      <section className="settings-section">
        <h2>外观</h2>
        <div className="setting-row">
          <span>主题</span>
          <div className="segmented theme-segmented">
            {(
              [
                { id: "light", name: "浅色" },
                { id: "dark", name: "深色" },
                { id: "system", name: "跟随系统" },
              ] as const
            ).map((theme) => (
              <button
                key={theme.id}
                disabled={busy}
                className={settings.theme === theme.id ? "selected" : ""}
                aria-pressed={settings.theme === theme.id}
                onClick={() => {
                  void save({ theme: theme.id });
                }}
              >
                {theme.name}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h2>音源</h2>
        <div className="source-settings">
          {snapshot.sources.map((source) => (
            <div key={source.id} className="setting-row source-setting">
              <div className="source-identity">
                <span
                  className="source-mark"
                  style={{ backgroundColor: source.color }}
                />
                <div>
                  <strong>{source.name}</strong>
                  <small>{source.access}</small>
                </div>
              </div>
              <span className="source-state">
                {!source.implemented
                  ? "未接入"
                  : !source.configured
                    ? "需要 Client ID"
                    : source.enabled
                      ? "已启用"
                      : "未启用"}
              </span>
              <Switch
                checked={source.enabled}
                disabled={busy || !source.implemented || !source.configured}
                label={`启用${source.name}`}
                onChange={(value) => sourceEnabled(source.id, value)}
              />
            </div>
          ))}
        </div>
        <form
          className="credential-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!key.trim()) return;
            setBusy(true);
            await act(async () => {
              await api.setJamendoKey(key.trim());
              setKey("");
              await useApp.getState().refresh();
            }, "Client ID 已安全保存");
            setBusy(false);
          }}
        >
          <label htmlFor="jamendo-key">Jamendo Client ID</label>
          <div className="inline-form">
            <input
              id="jamendo-key"
              type="password"
              autoComplete="off"
              maxLength={100}
              placeholder={
                snapshot.sources.find((source) => source.id === "jamendo")
                  ?.configured
                  ? "已配置，输入新值替换"
                  : "尚未配置"
              }
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button type="submit" icon={Check} disabled={busy || !key.trim()}>
              保存
            </Button>
            {snapshot.sources.find((source) => source.id === "jamendo")
              ?.configured && (
              <IconButton
                icon={Trash2}
                label="移除 Jamendo Client ID"
                disabled={busy}
                onClick={() => {
                  void act(async () => {
                    await api.setJamendoKey("");
                    await api.saveSettings({
                      ...settings,
                      enabledSources: settings.enabledSources.filter(
                        (id) => id !== "jamendo",
                      ),
                    });
                    await useApp.getState().refresh();
                  }, "已移除 Client ID");
                }}
              />
            )}
          </div>
        </form>
      </section>
      <section className="settings-section">
        <h2>本地音乐</h2>
        <div className="section-heading">
          <span className="muted">扫描目录</span>
          <Button
            icon={Plus}
            disabled={useApp.getState().importing}
            onClick={() => {
              void useApp.getState().importMusic("folder");
            }}
          >
            添加目录
          </Button>
        </div>
        {snapshot.folders.length ? (
          snapshot.folders.map((folder) => (
            <div className="folder-setting" key={folder.path}>
              <FolderOpen size={18} />
              <div>
                <strong title={folder.path}>{folder.path}</strong>
                <small>
                  {folder.count} 首 ·{" "}
                  {new Date(folder.lastScan).toLocaleString("zh-CN")}
                </small>
              </div>
              <IconButton
                icon={RefreshCw}
                label={`重新扫描 ${folder.path}`}
                disabled={useApp.getState().importing}
                onClick={() => {
                  void useApp.getState().importMusic("paths", [folder.path]);
                }}
              />
              <IconButton
                icon={Trash2}
                label={`移除扫描目录 ${folder.path}`}
                onClick={() => {
                  void act(async () => {
                    await api.removeScanFolder(folder.path);
                    await useApp.getState().refresh();
                  });
                }}
              />
            </div>
          ))
        ) : (
          <p className="muted settings-empty">未添加扫描目录</p>
        )}
      </section>
      <section className="settings-section">
        <h2>下载</h2>
        <div className="setting-row download-setting">
          <div>
            <span>保存位置</span>
            <small title={settings.downloadDir}>{settings.downloadDir}</small>
          </div>
          <Button
            icon={FolderOpen}
            disabled={busy}
            onClick={async () => {
              const dir = await api.chooseDownloadDir();
              if (dir) await save({ downloadDir: dir });
            }}
          >
            更改
          </Button>
        </div>
      </section>
      <section className="settings-section">
        <h2>播放与窗口</h2>
        <div className="setting-row">
          <span>系统媒体键</span>
          <Switch
            checked={settings.mediaKeys}
            disabled={busy}
            label="系统媒体键"
            onChange={(mediaKeys) => {
              void save({ mediaKeys });
            }}
          />
        </div>
        <div className="setting-row">
          <span>关闭窗口后保留在托盘</span>
          <Switch
            checked={settings.closeToTray}
            disabled={busy}
            label="关闭窗口后保留在托盘"
            onChange={(closeToTray) => {
              void save({ closeToTray });
            }}
          />
        </div>
      </section>
      <footer className="settings-footer">
        <span>声迹</span>
        <span>{version}</span>
        <span>Electron · SQLite</span>
      </footer>
    </>
  );
}
