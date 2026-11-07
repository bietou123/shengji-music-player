import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AudioLines,
  CheckCircle2,
  ChevronLeft,
  Compass,
  FolderOpen,
  Heart,
  History,
  ListMusic,
  ListOrdered,
  LoaderCircle,
  Maximize2,
  Mic2,
  Minus,
  Monitor,
  Music2,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  PictureInPicture2,
  Play,
  Plus,
  Repeat,
  Repeat1,
  RotateCw,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Square,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";
import { AVAILABILITY_NAMES, formatTime } from "../shared/catalog";
import type { MiniState, PlayMode, Track } from "../shared/types";
import { api } from "./api";
import { act, useApp, type View } from "./store";
import { player, usePlayer } from "./player";
import { AudioEffectsModal } from "./AudioEffects";
import { Spectrum } from "./Spectrum";
import {
  AddPlaylistModal,
  Button,
  Cover,
  EmptyState,
  IconButton,
  PlaylistNameModal,
} from "./components";
import {
  AlbumView,
  DiscoverView,
  DownloadsView,
  LibraryView,
  PlaylistView,
  PlaylistsView,
  SearchView,
  SettingsView,
  type AlbumGroup,
} from "./views";

export function applyTheme(theme: "light" | "dark" | "system"): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    document.documentElement.dataset.theme =
      theme === "system" ? (query.matches ? "dark" : "light") : theme;
  };
  update();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

const navigation: { view: View; name: string; icon: LucideIcon }[] = [
  { view: "discover", name: "发现音乐", icon: Compass },
  { view: "search", name: "搜索", icon: Search },
  { view: "library", name: "本地音乐", icon: Music2 },
  { view: "favorites", name: "我的收藏", icon: Heart },
  { view: "recent", name: "最近播放", icon: History },
  { view: "downloads", name: "下载", icon: ArrowDownToLine },
];

function Sidebar({ onCreate }: { onCreate(): void }) {
  const { view, snapshot, importing, importMusic } = useApp();
  return (
    <aside className="sidebar" aria-label="主导航">
      <nav>
        {navigation.map((item, index) => (
          <div key={item.view}>
            {index === 2 && <div className="nav-label">资料库</div>}
            <button
              className={`nav-item ${view === item.view ? "selected" : ""}`}
              title={item.name}
              onClick={() => useApp.setState({ view: item.view })}
            >
              <item.icon size={19} strokeWidth={1.7} />
              <span>{item.name}</span>
              {item.view === "favorites" &&
                Boolean(snapshot?.favorites.length) && (
                  <small>{snapshot!.favorites.length}</small>
                )}
            </button>
          </div>
        ))}
      </nav>
      <div className="playlist-nav-heading">
        <button
          className={view === "playlists" ? "selected" : ""}
          onClick={() => useApp.setState({ view: "playlists" })}
        >
          <ListMusic size={16} />
          <span>我的歌单</span>
        </button>
        <IconButton icon={Plus} label="新建歌单" onClick={onCreate} />
      </div>
      <div className="sidebar-playlists">
        {snapshot?.playlists.map((playlist) => (
          <button
            key={playlist.id}
            title={playlist.name}
            className={`playlist-nav-item ${view === `playlist:${playlist.id}` ? "selected" : ""}`}
            onClick={() => useApp.setState({ view: `playlist:${playlist.id}` })}
          >
            <Cover track={playlist.tracks[0]} size={26} />
            <span>{playlist.name}</span>
            <small>{playlist.tracks.length}</small>
          </button>
        ))}
      </div>
      <div className="sidebar-bottom">
        <button
          className="nav-item"
          disabled={importing}
          onClick={() => {
            void importMusic("folder");
          }}
          title="导入文件夹"
        >
          <FolderOpen size={18} />
          <span>导入文件夹</span>
        </button>
        <button
          className={`nav-item ${view === "settings" ? "selected" : ""}`}
          title="设置"
          onClick={() => useApp.setState({ view: "settings" })}
        >
          <Settings size={18} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}

function TitleBar({
  canBack,
  canForward,
  onBack,
  onForward,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
}) {
  const { query, view, search } = useApp();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (view === "search" && !useApp.getState().lastQuery)
      input.current?.focus();
  }, [view]);
  return (
    <header className="titlebar">
      <div className="brand">
        <span className="brand-mark">
          <AudioLines size={23} strokeWidth={1.8} />
        </span>
        <strong>声迹</strong>
      </div>
      <div className="titlebar-center">
        <div className="navigation-controls">
          <IconButton
            icon={ArrowLeft}
            label="后退"
            disabled={!canBack}
            onClick={onBack}
          />
          <IconButton
            icon={ArrowRight}
            label="前进"
            disabled={!canForward}
            onClick={onForward}
          />
        </div>
        <form
          className="global-search"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <Search size={17} />
          <input
            ref={input}
            aria-label="搜索音乐"
            placeholder="搜索歌曲、歌手、专辑"
            value={query}
            maxLength={150}
            onChange={(event) => useApp.setState({ query: event.target.value })}
          />
          {query ? (
            <IconButton
              icon={X}
              label="清空搜索内容"
              onClick={() => {
                useApp.setState({ query: "" });
                input.current?.focus();
              }}
            />
          ) : (
            <span className="search-mark">音乐</span>
          )}
        </form>
      </div>
      <div className="window-controls">
        <IconButton
          className="mini-toggle"
          icon={PictureInPicture2}
          label="迷你播放器"
          onClick={() => {
            void act(() => api.windowAction("mini"));
          }}
        />
        <span className="window-divider" />
        <IconButton
          icon={Minus}
          label="最小化"
          onClick={() => {
            void api.windowAction("minimize");
          }}
        />
        <IconButton
          icon={Square}
          label="最大化或还原"
          onClick={() => {
            void api.windowAction("maximize");
          }}
        />
        <IconButton
          icon={X}
          className="window-close"
          label="关闭声迹"
          onClick={() => {
            void api.windowAction("close");
          }}
        />
      </div>
    </header>
  );
}

const MODE_NAMES: Record<PlayMode, string> = {
  order: "顺序播放",
  loop: "列表循环",
  one: "单曲循环",
  shuffle: "随机播放",
};
const MODE_ICONS: Record<PlayMode, LucideIcon> = {
  order: ListOrdered,
  loop: Repeat,
  one: Repeat1,
  shuffle: Shuffle,
};
const modes: PlayMode[] = ["order", "loop", "one", "shuffle"];

function PlayerBar({ onLyrics, onEffects }: { onLyrics(): void; onEffects(): void }) {
  const state = usePlayer();
  const favorites = useApp((app) => app.snapshot?.favorites);
  const queueVisible = useApp((app) => app.queueVisible);
  const isFavorite = Boolean(
    favorites?.some((track) => track.id === state.current?.id),
  );
  const playing = state.status === "playing";
  const volumeIcon =
    state.muted || state.volume === 0
      ? VolumeX
      : state.volume < 0.5
        ? Volume1
        : Volume2;
  return (
    <footer className="player-bar" aria-label="播放控制" data-playing={playing}>
      <div className="now-playing">
        <button
          className="now-art-button"
          title="歌词与播放队列"
          onClick={onLyrics}
          disabled={!state.current}
        >
          <Cover track={state.current} size={54} eager />
        </button>
        <div className="now-meta">
          <div>
            <strong title={state.current?.title}>
              {state.current?.title ?? "声迹"}
            </strong>
            {state.current?.availability === "preview" && (
              <span className="status-tag preview">试听</span>
            )}
          </div>
          <span title={state.current?.artist}>
            {state.current?.artist ?? "未选择音乐"}
          </span>
          {state.current && (
            <small>
              {state.current.format && !state.current.quality?.startsWith(state.current.format) ? `${state.current.format} ` : ""}
              {state.current.quality}
            </small>
          )}
        </div>
        <IconButton
          icon={Heart}
          className={isFavorite ? "heart-filled" : ""}
          label={isFavorite ? "取消当前收藏" : "收藏当前歌曲"}
          active={isFavorite}
          disabled={!state.current}
          onClick={() => {
            if (state.current)
              void act(async () => {
                await api.favorite(state.current!.id, !isFavorite);
                await useApp.getState().refresh();
              });
          }}
        />
      </div>
      <div className="transport">
        <div className="transport-buttons">
          <IconButton
            icon={MODE_ICONS[state.mode]}
            label={MODE_NAMES[state.mode]}
            active={state.mode !== "order"}
            onClick={() =>
              player.mode(modes[(modes.indexOf(state.mode) + 1) % modes.length])
            }
          />
          <IconButton
            icon={SkipBack}
            label="上一首"
            disabled={!state.queue.length}
            onClick={() => player.previous()}
          />
          <IconButton
            icon={
              state.status === "loading" ? LoaderCircle : playing ? Pause : Play
            }
            label={
              playing ? "暂停" : state.status === "error" ? "重试播放" : "播放"
            }
            className={`play-button ${state.status === "loading" ? "loading-button" : ""}`}
            disabled={!state.current && !state.queue.length}
            onClick={() => player.toggle()}
          />
          <IconButton
            icon={SkipForward}
            label="下一首"
            disabled={!state.queue.length}
            onClick={() => player.next()}
          />
          <IconButton
            icon={Mic2}
            label="歌词"
            onClick={onLyrics}
            active={queueVisible && false}
            disabled={!state.current}
          />
        </div>
        <div className="timeline">
          <span className="tabular">{formatTime(state.position)}</span>
          <input
            className="range progress-range"
            type="range"
            aria-label="播放进度"
            min={0}
            max={state.duration || 1}
            step={0.1}
            value={Math.min(state.position, state.duration || 1)}
            disabled={!state.current || state.duration <= 0}
            style={
              {
                "--range-progress": `${state.duration ? (state.position / state.duration) * 100 : 0}%`,
              } as React.CSSProperties
            }
            aria-valuetext={formatTime(state.position)}
            onChange={(event) => player.seek(Number(event.target.value))}
          />
          <span className="tabular">{formatTime(state.duration)}</span>
        </div>
      </div>
      <div className="player-tools">
        <Spectrum compact />
        <IconButton icon={SlidersHorizontal} label="音效" active={state.effects.enabled} onClick={onEffects} />
        <div className="volume-control">
          <IconButton
            icon={volumeIcon}
            label={state.muted ? "取消静音" : "静音"}
            active={state.muted}
            onClick={() => player.mute()}
          />
          <input
            className="range volume-range"
            aria-label="音量"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={state.volume}
            style={
              {
                "--range-progress": `${state.muted ? 0 : state.volume * 100}%`,
              } as React.CSSProperties
            }
            onChange={(event) => player.volume(Number(event.target.value))}
          />
          <span className="volume-number tabular">
            {state.muted ? 0 : Math.round(state.volume * 100)}
          </span>
        </div>
        <IconButton
          icon={queueVisible ? PanelRightClose : PanelRightOpen}
          label={queueVisible ? "收起播放队列" : "展开播放队列"}
          active={queueVisible}
          aria-pressed={queueVisible}
          onClick={() => useApp.setState({ queueVisible: !queueVisible })}
        />
      </div>
      {state.status === "error" && state.error && (
        <div className="player-error" role="alert">
          <AlertCircle size={15} />
          <span>{state.error}</span>
          <Button
            variant="text"
            icon={RotateCw}
            onClick={() => {
              void player.play();
            }}
          >
            重试
          </Button>
          <IconButton
            icon={X}
            label="关闭播放错误"
            onClick={() => usePlayer.setState({ error: "" })}
          />
        </div>
      )}
    </footer>
  );
}

function Lyrics() {
  const { current, lyrics, position, lyricsLoading, lyricsError, status } = usePlayer();
  const container = useRef<HTMLDivElement>(null);
  const activeIndex = lyrics.synchronized ? lyrics.lines.findLastIndex(
    (line) => line.timestamp <= position,
  ) : -1;
  useEffect(() => {
    const active =
      container.current?.querySelector<HTMLElement>(".lyric-line.active");
    if (active && container.current)
      container.current.scrollTo({
        top:
          active.offsetTop -
          container.current.offsetTop -
          container.current.clientHeight / 2 +
          active.clientHeight / 2,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? "instant" : "smooth",
      });
  }, [activeIndex]);
  return (
    <div className="lyrics-content" data-playing={status === "playing"} aria-busy={lyricsLoading}>
      <div className="lyric-artwork" key={current?.id}>
        <Cover track={current} eager />
        <strong title={current?.title}>{current?.title}</strong>
        <span title={current?.artist}>{current?.artist}</span>
      </div>
      {lyrics.status === 'available' ? (
        <>
        <div className="lyrics-source"><span>{lyrics.source === 'local' ? '本地歌词' : lyrics.source === 'netease' ? '网易云音乐' : 'LRCLIB'}{!lyrics.synchronized ? ' · 未同步' : ''}</span><IconButton icon={lyricsLoading ? LoaderCircle : RotateCw} className={lyricsLoading ? 'spin' : ''} label="刷新歌词" disabled={lyricsLoading} onClick={() => { void player.loadLyrics(current?.source === 'local' && lyrics.source !== 'local', true); }} /></div>
        <div className="lyric-lines" ref={container}>
          {lyrics.lines.map((line, index) => lyrics.synchronized ? (
            <button
              key={`${line.timestamp}:${index}`}
              className={`lyric-line ${index === activeIndex ? "active" : ""}`}
              onClick={() => player.seek(line.timestamp)}
            >
              <span>{line.content}</span>
              {line.translation && <small>{line.translation}</small>}
            </button>
          ) : <div className="lyric-line" key={index}>{line.content}</div>)}
        </div>
        {lyricsError && <p className="lyrics-error" role="alert">{lyricsError}</p>}
        </>
      ) : (
        <div className="instrumental-view">
          {lyricsLoading ? <LoaderCircle className="spin" size={18} /> : lyricsError ? <AlertCircle size={19} /> : <AudioLines size={19} />}
          <h3>{lyricsLoading ? '正在获取歌词' : lyricsError ? '歌词加载失败' : lyrics.status === 'instrumental' ? '纯音乐' : lyrics.status === 'unsupported' && current?.availability === 'preview' ? '试听无同步歌词' : lyrics.status === 'unmatched' ? '未找到匹配歌词' : '暂无歌词'}</h3>
          {lyricsError && <p className="lyrics-error" role="alert">{lyricsError}</p>}
          <Spectrum />
          <div className="spectrum-scale"><span>低频</span><span>中频</span><span>高频</span></div>
          {lyrics.source && <span className="lyrics-origin">{lyrics.source === 'netease' ? '网易云音乐' : lyrics.source === 'lrclib' ? 'LRCLIB' : '本地歌词'}</span>}
          {current?.source === 'local' && <Button icon={Search} disabled={lyricsLoading} title="向网易云音乐和 LRCLIB 发送歌曲名、歌手与时长" onClick={() => { void player.loadLyrics(true, true); }}>匹配在线歌词</Button>}
          {current?.source === 'netease' && <Button icon={RotateCw} disabled={lyricsLoading} variant="text" onClick={() => { void player.loadLyrics(false, true); }}>重试歌词</Button>}
        </div>
      )}
    </div>
  );
}

function QueuePanel({
  tab,
  onTab,
}: {
  tab: "queue" | "lyrics";
  onTab(tab: "queue" | "lyrics"): void;
}) {
  const { queue, current, index, status } = usePlayer();
  return (
    <aside className="queue-panel" aria-label="播放队列">
      <div className="queue-heading">
        <div role="tablist">
          <button
            role="tab"
            aria-selected={tab === "queue"}
            className={tab === "queue" ? "selected" : ""}
            onClick={() => onTab("queue")}
          >
            播放队列 <span>{queue.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "lyrics"}
            className={tab === "lyrics" ? "selected" : ""}
            onClick={() => onTab("lyrics")}
          >
            歌词
          </button>
        </div>
        <IconButton
          icon={PanelRightClose}
          label="关闭侧边队列"
          onClick={() => useApp.setState({ queueVisible: false })}
        />
      </div>
      {tab === "lyrics" ? (
        <Lyrics />
      ) : (
        <>
          <div className="queue-subheading">
            <span>
              {current ? `正在播放 · ${index + 1} / ${queue.length}` : "待播放"}
            </span>
            <IconButton
              icon={Trash2}
              label="清空播放队列"
              disabled={!queue.length}
              onClick={() => player.clear()}
            />
          </div>
          <div className="queue-list">
            {queue.length ? (
              queue.map((track, i) => (
                <div
                  key={`${track.id}:${i}`}
                  data-queue-index={i}
                  className={`queue-track ${i === index ? "current" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(
                      "application/x-shengji-queue",
                      String(i),
                    );
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => {
                    if (
                      event.dataTransfer.types.includes(
                        "application/x-shengji-queue",
                      )
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const from = event.dataTransfer.getData(
                      "application/x-shengji-queue",
                    );
                    if (from !== "") {
                      event.preventDefault();
                      player.move(Number(from), i);
                    }
                  }}
                >
                  <button
                    className="queue-track-play"
                    aria-label={`播放队列第 ${i + 1} 首 ${track.title}`}
                    title={`播放 ${track.title}`}
                    onClick={() => {
                      void player.select(i);
                    }}
                  >
                    {i === index && status === "playing" ? (
                      <AudioLines size={15} />
                    ) : (
                      <span>{i + 1}</span>
                    )}
                  </button>
                  <Cover track={track} size={34} />
                  <button
                    className="queue-track-info"
                    onClick={() => {
                      void player.select(i);
                    }}
                  >
                    <strong title={track.title}>{track.title}</strong>
                    <span title={track.artist}>{track.artist}</span>
                  </button>
                  <div className="queue-track-actions">
                    <div className="queue-move">
                      <IconButton
                        icon={ArrowUp}
                        label={`上移队列第 ${i + 1} 首`}
                        disabled={i === 0}
                        onClick={() => player.move(i, i - 1)}
                      />
                      <IconButton
                        icon={ArrowDown}
                        label={`下移队列第 ${i + 1} 首`}
                        disabled={i === queue.length - 1}
                        onClick={() => player.move(i, i + 1)}
                      />
                    </div>
                    <IconButton
                      icon={X}
                      label={`移除队列第 ${i + 1} 首`}
                      onClick={() => player.remove(i)}
                    />
                  </div>
                </div>
              ))
            ) : (
              <EmptyState icon={ListMusic} title="队列为空" />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

async function boot(): Promise<void> {
  const snapshot = await useApp.getState().refresh();
  if (snapshot.localTracks.length) useApp.setState({ view: "library" });
  await player.initialize(snapshot);
  void useApp.getState().discover();
}

export function App() {
  const {
    ready,
    snapshot,
    view,
    queueVisible,
    bootError,
    toast,
    importing,
    importProgress,
  } = useApp();
  const [create, setCreate] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [adding, setAdding] = useState<Track[] | null>(null);
  const [album, setAlbum] = useState<AlbumGroup | null>(null);
  const [queueTab, setQueueTab] = useState<"queue" | "lyrics">("queue");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const history = useRef<View[]>(["discover"]);
  const historyIndex = useRef(0);
  const [, setNavigationVersion] = useState(0);
  useEffect(() => {
    void boot().catch(() => undefined);
    return api.onImportProgress((progress) =>
      useApp.setState({ importProgress: progress }),
    );
  }, []);
  useEffect(
    () => applyTheme(snapshot?.settings.theme ?? "light"),
    [snapshot?.settings.theme],
  );
  useEffect(() => {
    const smallWindow = window.matchMedia('(max-width: 1180px)');
    const collapse = () => { if (smallWindow.matches) useApp.setState({ queueVisible: false }); };
    collapse();
    smallWindow.addEventListener('change', collapse);
    return () => smallWindow.removeEventListener('change', collapse);
  }, []);
  useEffect(() => {
    setAlbum(null);
    if (history.current[historyIndex.current] !== view) {
      history.current = [
        ...history.current.slice(0, historyIndex.current + 1),
        view,
      ];
      historyIndex.current = history.current.length - 1;
      setNavigationVersion((value) => value + 1);
    }
  }, [view]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          'input,textarea,select,button,[role="dialog"],[role="menu"]',
        )
      )
        return;
      if (event.code === "Space") {
        event.preventDefault();
        player.toggle();
      }
      if (event.key === "ArrowRight")
        player.seek(usePlayer.getState().position + 5);
      if (event.key === "ArrowLeft")
        player.seek(usePlayer.getState().position - 5);
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, []);
  if (!ready)
    return (
      <div className="boot-screen">
        <AudioLines size={34} />
        <LoaderCircle className="spin" size={18} />
      </div>
    );
  if (bootError && !snapshot)
    return (
      <div className="boot-screen">
        <EmptyState
          icon={AlertCircle}
          title="资料库加载失败"
          detail={bootError}
          action={
            <Button
              icon={RotateCw}
              onClick={() => {
                void boot().catch(() => undefined);
              }}
            >
              重试
            </Button>
          }
        />
      </div>
    );
  const navigate = (delta: number) => {
    historyIndex.current += delta;
    useApp.setState({ view: history.current[historyIndex.current] });
    setNavigationVersion((value) => value + 1);
  };
  const showLyrics = () => {
    useApp.setState({ queueVisible: true });
    setQueueTab("lyrics");
  };
  let content: ReactNode;
  if (album)
    content = (
      <AlbumView
        album={album}
        onBack={() => setAlbum(null)}
        onAddPlaylist={setAdding}
      />
    );
  else if (view === "discover")
    content = <DiscoverView onOpenAlbum={setAlbum} onAddPlaylist={setAdding} />;
  else if (view === "search")
    content = <SearchView onOpenAlbum={setAlbum} onAddPlaylist={setAdding} />;
  else if (view === "library" || view === "favorites" || view === "recent")
    content = (
      <LibraryView
        type={view}
        onOpenAlbum={setAlbum}
        onAddPlaylist={setAdding}
      />
    );
  else if (view === "playlists")
    content = <PlaylistsView onCreate={() => setCreate(true)} />;
  else if (view.startsWith("playlist:"))
    content = (
      <PlaylistView key={view} id={view.slice(9)} onAddPlaylist={setAdding} />
    );
  else if (view === "downloads") content = <DownloadsView />;
  else content = <SettingsView />;
  return (
    <div
      className={`app ${queueVisible ? "queue-open" : ""}`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          dragDepth.current--;
          if (dragDepth.current <= 0) setDragging(false);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => api.filePath(file))
          .filter(Boolean);
        if (paths.length) void useApp.getState().importMusic("paths", paths);
      }}
    >
      <TitleBar
        canBack={historyIndex.current > 0}
        canForward={historyIndex.current < history.current.length - 1}
        onBack={() => navigate(-1)}
        onForward={() => navigate(1)}
      />
      <Sidebar onCreate={() => setCreate(true)} />
      <main className="main-content" key={view}>
        <div className="content-inner">{content}</div>
      </main>
      {queueVisible && <QueuePanel tab={queueTab} onTab={setQueueTab} />}
      <PlayerBar onLyrics={showLyrics} onEffects={() => setEffectsOpen(true)} />
      {effectsOpen && <AudioEffectsModal onClose={() => setEffectsOpen(false)} />}
      {create && <PlaylistNameModal onClose={() => setCreate(false)} />}
      {adding && (
        <AddPlaylistModal tracks={adding} onClose={() => setAdding(null)} />
      )}
      {toast && (
        <div
          className={`toast ${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          {toast.tone === "error" ? (
            <AlertCircle size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          <span>{toast.message}</span>
          <IconButton
            icon={X}
            label="关闭提示"
            onClick={() => useApp.setState({ toast: null })}
          />
        </div>
      )}
      {importing && (
        <div className="import-status" role="status">
          <LoaderCircle className="spin" size={15} />
          <span>
            {importProgress
              ? `正在导入 ${importProgress.done} / ${importProgress.total}`
              : "正在读取音乐"}
          </span>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <FolderOpen size={36} />
          <span>导入音乐</span>
        </div>
      )}
    </div>
  );
}

export function MiniPlayer() {
  const [state, setState] = useState<MiniState>({
    current: null,
    status: "idle",
    position: 0,
    duration: 0,
    volume: 0.65,
    muted: false,
  });
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void api.bootstrap().then((snapshot) => {
      cleanup = applyTheme(snapshot.settings.theme);
    });
    const unsubscribe = api.onMiniState(setState);
    api.miniCommand("refresh");
    return () => {
      unsubscribe();
      cleanup?.();
    };
  }, []);
  return (
    <div className="mini-player">
      <div className="mini-titlebar">
        <span>
          <AudioLines size={13} />
          声迹
        </span>
        <div>
          <IconButton
            icon={Maximize2}
            label="还原主播放器"
            onClick={() => {
              void api.windowAction("main");
            }}
          />
          <IconButton
            icon={X}
            label="关闭迷你播放器"
            onClick={() => {
              void api.windowAction("mini-close");
            }}
          />
        </div>
      </div>
      <div className="mini-track">
        <Cover track={state.current} size={50} eager />
        <div>
          <strong title={state.current?.title}>
            {state.current?.title ?? "未选择音乐"}
          </strong>
          <span>{state.current?.artist ?? ""}</span>
          <small>
            {state.current?.availability === "preview"
              ? "官方试听"
              : state.status === "error"
                ? "播放失败"
                : (state.current?.quality ?? "")}
          </small>
        </div>
        <div className="mini-transport">
          <IconButton
            icon={SkipBack}
            label="上一首"
            disabled={!state.current}
            onClick={() => api.miniCommand("previous")}
          />
          <IconButton
            className="mini-play-button"
            icon={state.status === "playing" ? Pause : Play}
            label={state.status === "playing" ? "暂停" : "播放"}
            disabled={!state.current}
            onClick={() => api.miniCommand("toggle")}
          />
          <IconButton
            icon={SkipForward}
            label="下一首"
            disabled={!state.current}
            onClick={() => api.miniCommand("next")}
          />
        </div>
      </div>
      <div className="mini-timeline">
        <span>{formatTime(state.position)}</span>
        <progress max={state.duration || 1} value={state.position} />
        <span>{formatTime(state.duration)}</span>
      </div>
    </div>
  );
}
