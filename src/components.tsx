import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Disc3,
  FolderOpen,
  Heart,
  ListEnd,
  ListPlus,
  LoaderCircle,
  MoreHorizontal,
  Music2,
  Play,
  Plus,
  SkipForward,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  AVAILABILITY_NAMES,
  formatTime,
  playable,
  SOURCE_NAMES,
} from "../shared/catalog";
import type { Track, TrackGroup } from "../shared/types";
import { api } from "./api";
import { act, useApp } from "./store";
import { player, usePlayer } from "./player";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  active?: boolean;
}
export function IconButton({
  icon: Icon,
  label,
  active,
  className = "",
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "active" : ""} ${className}`}
      title={label}
      aria-label={label}
      {...props}
    >
      <Icon size={18} strokeWidth={1.8} />
    </button>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon;
  variant?: "primary" | "secondary" | "danger" | "text";
  children: ReactNode;
}
export function Button({
  icon: Icon,
  variant = "secondary",
  children,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`button ${variant} ${className}`}
      {...props}
    >
      {Icon && <Icon size={16} strokeWidth={1.8} />}
      <span>{children}</span>
    </button>
  );
}

export function Cover({
  track,
  className = "",
  size,
  eager = false,
}: {
  track?: Pick<Track, "artwork" | "album" | "title"> | null;
  className?: string;
  size?: number;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [track?.artwork]);
  return (
    <div
      className={`cover ${className}`}
      style={size ? { width: size, height: size } : undefined}
    >
      {track?.artwork && !failed ? (
        <img
          src={track.artwork}
          alt={track.album || track.title}
          loading={eager ? "eager" : "lazy"}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Disc3
          size={size ? Math.max(18, Math.round(size * 0.4)) : 42}
          strokeWidth={1.15}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Music2,
  title,
  action,
  detail,
}: {
  icon?: LucideIcon;
  title: string;
  action?: ReactNode;
  detail?: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={42} strokeWidth={1.2} />
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ grid = false }: { grid?: boolean }) {
  return (
    <div
      className={grid ? "album-grid skeleton-grid" : "skeleton-list"}
      aria-label="加载中"
      aria-busy="true"
    >
      {Array.from({ length: grid ? 8 : 7 }, (_, index) => (
        <div key={index} className={grid ? "skeleton-album" : "skeleton-row"}>
          <div className="skeleton cover" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]',
        ) ?? [],
      );
    focusable()
      .find((element) => element.tagName === "INPUT")
      ?.focus();
    if (!panel.current?.contains(document.activeElement))
      focusable()[0]?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
      previous?.focus();
    };
  }, [onClose]);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${className}`}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <IconButton icon={X} label="关闭对话框" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmModal({
  title,
  message,
  onClose,
  onConfirm,
  confirm = "删除",
}: {
  title: string;
  message: string;
  onClose(): void;
  onConfirm(): Promise<unknown>;
  confirm?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-copy">{message}</p>
      <div className="modal-actions">
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          variant="danger"
          icon={busy ? LoaderCircle : Trash2}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            if (await act(onConfirm)) onClose();
            setBusy(false);
          }}
        >
          {confirm}
        </Button>
      </div>
    </Modal>
  );
}

export function Dropdown({
  children,
  label = "更多操作",
  icon = MoreHorizontal,
}: {
  children: ReactNode;
  label?: string;
  icon?: LucideIcon;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchor.current!.getBoundingClientRect();
    const height = menu.current?.getBoundingClientRect().height ?? 250;
    setPosition({
      left: Math.max(8, Math.min(rect.right - 218, window.innerWidth - 226)),
      top:
        rect.bottom + height + 8 > window.innerHeight
          ? Math.max(8, rect.top - height - 4)
          : rect.bottom + 4,
    });
    menu.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        anchor.current?.querySelector("button")?.focus();
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = Array.from(
        menu.current?.querySelectorAll<HTMLButtonElement>(
          "button:not([disabled])",
        ) ?? [],
      );
      const index = items.findIndex((item) => item === document.activeElement);
      items[
        (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length
      ]?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    window.addEventListener("resize", () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open]);
  return (
    <span
      ref={anchor}
      className="dropdown-anchor"
      onClick={(event) => event.stopPropagation()}
    >
      <IconButton
        icon={icon}
        label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className="dropdown-menu"
            style={position}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  disabled,
  danger = false,
}: {
  icon: LucideIcon;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger-text" : ""}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} />
      <span>{children}</span>
    </button>
  );
}

export function AddPlaylistModal({
  tracks,
  onClose,
}: {
  tracks: Track[];
  onClose(): void;
}) {
  const playlists = useApp((state) => state.snapshot?.playlists ?? []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async (id: string) => {
    setBusy(true);
    const success = await act(async () => {
      await api.addToPlaylist(
        id,
        tracks.map((track) => track.id),
      );
      await useApp.getState().refresh();
    }, "已加入歌单");
    if (success) onClose();
    setBusy(false);
  };
  return (
    <Modal title="加入歌单" onClose={onClose}>
      <div className="playlist-picker">
        {playlists.map((playlist) => (
          <button
            key={playlist.id}
            className="playlist-picker-row"
            disabled={busy}
            onClick={() => {
              void add(playlist.id);
            }}
          >
            <Cover track={playlist.tracks[0]} size={42} />
            <span>
              <strong>{playlist.name}</strong>
              <small>{playlist.tracks.length} 首</small>
            </span>
            <Plus size={16} />
          </button>
        ))}
        {!playlists.length && <p className="muted">暂无歌单</p>}
      </div>
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          await act(async () => {
            const id = await api.createPlaylist(name.trim());
            await api.addToPlaylist(
              id,
              tracks.map((track) => track.id),
            );
            await useApp.getState().refresh();
            onClose();
          }, "已创建歌单");
          setBusy(false);
        }}
      >
        <input
          aria-label="新歌单名称"
          placeholder="新歌单名称"
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          icon={busy ? LoaderCircle : Plus}
          type="submit"
          variant="primary"
          disabled={busy || !name.trim()}
        >
          创建
        </Button>
      </form>
    </Modal>
  );
}

export function PlaylistNameModal({
  id,
  initial = "",
  onClose,
}: {
  id?: string;
  initial?: string;
  onClose(): void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={id ? "重命名歌单" : "新建歌单"} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          await act(async () => {
            const playlistId = id ?? (await api.createPlaylist(name.trim()));
            if (id) await api.renamePlaylist(id, name.trim());
            await useApp.getState().refresh();
            useApp.setState({ view: `playlist:${playlistId}` });
            onClose();
          });
          setBusy(false);
        }}
      >
        <label className="field-label" htmlFor="playlist-name">
          歌单名称
        </label>
        <input
          id="playlist-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          placeholder="我的歌单"
          autoFocus
        />
        <div className="modal-actions">
          <Button onClick={onClose}>取消</Button>
          <Button
            type="submit"
            variant="primary"
            icon={busy ? LoaderCircle : Check}
            disabled={busy || !name.trim()}
          >
            {id ? "保存" : "创建"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function TrackTable({
  groups,
  onAddPlaylist,
  playlistId,
  onReorder,
  emptyTitle = "暂无音乐",
}: {
  groups: TrackGroup[];
  onAddPlaylist(tracks: Track[]): void;
  playlistId?: string;
  onReorder?(from: number, to: number): void;
  emptyTitle?: string;
}) {
  const favorites = useApp((state) => state.snapshot?.favorites ?? []);
  const current = usePlayer((state) => state.current);
  const status = usePlayer((state) => state.status);
  const [remove, setRemove] = useState<Track | null>(null);
  const [alternatives, setAlternatives] = useState<TrackGroup | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const context = groups.map((group) => group.track);
  if (!groups.length) return <EmptyState title={emptyTitle} />;
  const favoriteIds = new Set(favorites.map((track) => track.id));
  const toggleFavorite = (track: Track) => {
    void act(async () => {
      await api.favorite(track.id, !favoriteIds.has(track.id));
      await useApp.getState().refresh();
    });
  };
  const download = async (track: Track) => {
    setDownloading(track.id);
    await act(async () => {
      const result = await api.download(track.id);
      if (result) {
        await useApp.getState().refresh();
        useApp.getState().notify("下载完成");
      }
    });
    setDownloading(null);
  };
  return (
    <>
      <div className="track-table" role="table" aria-label="音乐列表">
        <div className="track-row table-header" role="row">
          <span>#</span>
          <span>音乐</span>
          <span className="album-column">专辑</span>
          <span className="source-column">来源 / 音质</span>
          <span className="duration-column">时长</span>
          <span />
        </div>
        {groups.map((group, index) => {
          const track = group.track.id === current?.id ? current : group.track;
          const active = track.id === current?.id;
          return (
            <div
              key={track.id}
              role="row"
              data-track-id={track.id}
              className={`track-row ${active ? "current" : ""}`}
              onDoubleClick={() => {
                if (playable(track)) player.playTrack(track, context);
              }}
              draggable={Boolean(onReorder)}
              onDragStart={(event) => {
                if (onReorder)
                  event.dataTransfer.setData(
                    "application/x-shengji-playlist",
                    String(index),
                  );
              }}
              onDragOver={(event) => {
                if (
                  onReorder &&
                  event.dataTransfer.types.includes(
                    "application/x-shengji-playlist",
                  )
                )
                  event.preventDefault();
              }}
              onDrop={(event) => {
                const data = event.dataTransfer.getData(
                  "application/x-shengji-playlist",
                );
                if (onReorder && data !== "") {
                  event.preventDefault();
                  onReorder(Number(data), index);
                }
              }}
            >
              <div className="track-number">
                <span>
                  {active && status === "playing" ? (
                    <span className="equalizer">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    String(index + 1).padStart(2, "0")
                  )}
                </span>
                <IconButton
                  icon={playable(track) ? Play : ArrowUpRight}
                  label={
                    playable(track)
                      ? `播放 ${track.title}`
                      : `在原平台打开 ${track.title}`
                  }
                  onClick={() =>
                    playable(track)
                      ? player.playTrack(track, context)
                      : void act(() => api.openExternal(track.id))
                  }
                />
              </div>
              <div className="track-title-cell">
                <Cover track={track} size={38} />
                <div className="track-meta">
                  <strong title={track.title}>{track.title}</strong>
                  <div className="track-subtitle">
                    <span title={track.artist}>{track.artist}</span>
                    {track.source !== "local" && (
                      <span className={`status-tag ${track.availability}`}>
                        {AVAILABILITY_NAMES[track.availability]}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <span className="album-column ellipsis" title={track.album}>
                {track.album}
              </span>
              <div className="source-column source-cell">
                <span title={SOURCE_NAMES[track.source]}>
                  {SOURCE_NAMES[track.source]}
                </span>
                <small
                  title={`${track.format ?? ""} ${track.quality ?? ""}${track.sampleRate ? ` · ${track.sampleRate} Hz` : ""}`}
                >
                  {track.quality || "待解析"}
                  {group.alternatives.length > 1 && (
                    <button
                      className="source-options"
                      title="选择音源"
                      aria-label={`选择 ${track.title} 的音源`}
                      onClick={() => setAlternatives(group)}
                    >
                      +{group.alternatives.length - 1}
                    </button>
                  )}
                </small>
              </div>
              <span className="duration-column tabular muted">
                {formatTime(track.duration)}
              </span>
              <div className="row-actions">
                <IconButton
                  icon={Heart}
                  label={
                    favoriteIds.has(track.id)
                      ? `取消收藏 ${track.title}`
                      : `收藏 ${track.title}`
                  }
                  active={favoriteIds.has(track.id)}
                  className={favoriteIds.has(track.id) ? "heart-filled" : ""}
                  onClick={() => toggleFavorite(track)}
                />
                <Dropdown label={`${track.title} 的更多操作`}>
                  <MenuItem
                    icon={SkipForward}
                    disabled={!playable(track)}
                    onClick={() => player.enqueue(track, true)}
                  >
                    下一首播放
                  </MenuItem>
                  <MenuItem
                    icon={ListEnd}
                    disabled={!playable(track)}
                    onClick={() => player.enqueue(track)}
                  >
                    加入队列
                  </MenuItem>
                  <MenuItem
                    icon={ListPlus}
                    onClick={() => onAddPlaylist([track])}
                  >
                    加入歌单
                  </MenuItem>
                  {track.downloadable && (
                    <MenuItem
                      icon={
                        downloading === track.id
                          ? LoaderCircle
                          : ArrowDownToLine
                      }
                      disabled={Boolean(downloading)}
                      onClick={() => {
                        void download(track);
                      }}
                    >
                      下载音频
                    </MenuItem>
                  )}
                  {track.externalUrl && (
                    <MenuItem
                      icon={ArrowUpRight}
                      onClick={() => {
                        void act(() => api.openExternal(track.id));
                      }}
                    >
                      打开原平台
                    </MenuItem>
                  )}
                  {track.source === "local" && (
                    <MenuItem
                      icon={FolderOpen}
                      onClick={() => {
                        void act(() => api.revealFile(track.id));
                      }}
                    >
                      在文件夹中显示
                    </MenuItem>
                  )}
                  {playlistId && (
                    <MenuItem
                      icon={Trash2}
                      danger
                      onClick={() => {
                        void act(async () => {
                          await api.removeFromPlaylist(playlistId, track.id);
                          await useApp.getState().refresh();
                        });
                      }}
                    >
                      从歌单移除
                    </MenuItem>
                  )}
                  {track.source === "local" && !playlistId && (
                    <MenuItem
                      icon={Trash2}
                      danger
                      onClick={() => setRemove(track)}
                    >
                      从资料库移除
                    </MenuItem>
                  )}
                </Dropdown>
              </div>
            </div>
          );
        })}
      </div>
      {remove && (
        <ConfirmModal
          title="移除本地音乐"
          message={`从资料库移除「${remove.title}」？原始音频文件不会被删除。`}
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            player.removeTrack(remove.id);
            await player.persist();
            await api.removeLocal(remove.id);
            await useApp.getState().refresh();
          }}
          confirm="移除"
        />
      )}
      {alternatives && (
        <Modal title="选择音源" onClose={() => setAlternatives(null)}>
          <div className="source-picker">
            {alternatives.alternatives.map((track) => (
              <button
                key={track.id}
                className="source-picker-row"
                onClick={() => {
                  if (playable(track)) player.playTrack(track);
                  else void act(() => api.openExternal(track.id));
                  setAlternatives(null);
                }}
              >
                <Cover track={track} size={42} />
                <span>
                  <strong>{SOURCE_NAMES[track.source]}</strong>
                  <small>
                    {track.artist} · {track.quality || "待解析"}
                  </small>
                </span>
                <span className={`status-tag ${track.availability}`}>
                  {AVAILABILITY_NAMES[track.availability]}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
