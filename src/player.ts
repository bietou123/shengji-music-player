import { create } from "zustand";
import { api, errorMessage } from "./api";
import { playable } from "../shared/catalog";
import { moveItem, nextIndex } from "../shared/queue";
import { DEFAULT_AUDIO_EFFECTS, effectiveEffects } from "../shared/audio-effects";
import { AudioGraph } from "./audio-graph";
import type {
  AudioEffectsSettings,
  LibrarySnapshot,
  LyricsResult,
  MiniState,
  PlaybackState,
  PlayMode,
  Track,
} from "../shared/types";
import { useApp } from "./store";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";
interface PlayerStore {
  queue: Track[];
  index: number;
  current: Track | null;
  status: PlayerStatus;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  mode: PlayMode;
  error: string;
  lyrics: LyricsResult;
  lyricsLoading: boolean;
  lyricsError: string;
  effects: AudioEffectsSettings;
  effectsHeadroom: number;
  effectsError: string;
}
const emptyLyrics = (): LyricsResult => ({ lines: [], status: "missing", source: null, synchronized: false });
export const usePlayer = create<PlayerStore>(() => ({
  queue: [],
  index: -1,
  current: null,
  status: "idle",
  position: 0,
  duration: 0,
  volume: 0.65,
  muted: false,
  mode: "order",
  error: "",
  lyrics: emptyLyrics(),
  lyricsLoading: false,
  lyricsError: "",
  effects: { ...DEFAULT_AUDIO_EFFECTS, bands: [...DEFAULT_AUDIO_EFFECTS.bands] },
  effectsHeadroom: 0,
  effectsError: "",
}));

class PlaybackEngine {
  private audio: HTMLAudioElement | null = null;
  private epoch = 0;
  private intentPlay = false;
  private seekOnLoad = 0;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private savedAt = 0;
  private saving: Promise<void> = Promise.resolve();
  private initialized = false;
  private graph: AudioGraph | null = null;
  private lyricsEpoch = 0;
  private effectsTimer: ReturnType<typeof setTimeout> | undefined;
  private savingEffects: Promise<void> = Promise.resolve();

  async initialize(snapshot: LibrarySnapshot): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.audio = document.createElement("audio");
    this.audio.id = "audio-engine";
    this.audio.preload = "metadata";
    this.audio.crossOrigin = "anonymous";
    this.audio.hidden = true;
    document.body.append(this.audio);
    try { this.graph = new AudioGraph(this.audio); }
    catch { usePlayer.setState({ effectsError: "音频处理引擎不可用" }); }
    const state = snapshot.playback;
    const queue = snapshot.queueTracks;
    const index =
      queue[state.index]?.id === state.currentId
        ? state.index
        : queue.findIndex((track) => track.id === state.currentId);
    this.audio.volume = state.volume;
    this.audio.muted = state.muted;
    usePlayer.setState({
      queue,
      index,
      current: index >= 0 ? queue[index] : null,
      volume: state.volume,
      muted: state.muted,
      mode: state.mode,
      effects: snapshot.audioEffects,
    });
    this.configureEffects();
    this.audio.addEventListener("loadedmetadata", () => {
      if (!this.audio || !usePlayer.getState().current) return;
      clearTimeout(this.loadTimer);
      const duration = Number.isFinite(this.audio.duration)
        ? this.audio.duration
        : usePlayer.getState().current!.duration;
      this.audio.currentTime = Math.max(
        0,
        Math.min(this.seekOnLoad, Math.max(0, duration - 0.05)),
      );
      this.seekOnLoad = 0;
      usePlayer.setState({
        duration,
        position: this.audio.currentTime,
        status: this.intentPlay ? "loading" : "paused",
      });
      if (this.intentPlay) void this.startAudio();
    });
    this.audio.addEventListener("durationchange", () => {
      if (this.audio && Number.isFinite(this.audio.duration))
        usePlayer.setState({ duration: this.audio.duration });
    });
    this.audio.addEventListener("timeupdate", () => {
      if (this.audio) usePlayer.setState({ position: this.audio.currentTime });
      if (Date.now() - this.savedAt > 2000) void this.persist();
    });
    this.audio.addEventListener("playing", () => {
      if (!this.intentPlay) {
        this.audio?.pause();
        return;
      }
      clearTimeout(this.loadTimer);
      usePlayer.setState({ status: "playing", error: "" });
    });
    this.audio.addEventListener("waiting", () => {
      if (!this.intentPlay) return;
      usePlayer.setState({ status: "loading" });
      this.armTimeout();
    });
    this.audio.addEventListener("error", () => {
      if (!this.audio?.getAttribute("src")) return;
      const code = this.audio.error?.code;
      this.fail(
        code === 4
          ? "当前播放引擎不支持此音频，或音源已失效"
          : code === 2
            ? "音频连接中断，请重试"
            : "音频播放失败，请重试",
      );
    });
    this.audio.addEventListener("ended", () => this.next(true));
    usePlayer.subscribe((value) => this.broadcast(value));
    api.onCommand((command) => {
      if (command === "toggle") this.toggle();
      if (command === "next") this.next();
      if (command === "previous") this.previous();
      if (command === "pause") this.pause();
      if (command === "play") void this.play();
      if (command === "refresh") this.broadcast(usePlayer.getState());
    });
    this.installMediaSession();
    window.addEventListener("beforeunload", () => {
      void this.persist();
      void this.persistEffects();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void this.persist();
    });
    this.broadcast(usePlayer.getState());
    if (index >= 0) await this.select(index, false, state.position);
  }

  private armTimeout(): void {
    clearTimeout(this.loadTimer);
    const epoch = this.epoch;
    this.loadTimer = setTimeout(() => {
      if (epoch === this.epoch) this.fail("音频加载超时，请检查网络或重试");
    }, 25_000);
  }

  private fail(message: string): void {
    ++this.epoch;
    clearTimeout(this.loadTimer);
    this.intentPlay = false;
    this.audio?.pause();
    usePlayer.setState({ status: "error", error: message });
  }

  async select(index: number, autoplay = true, position = 0): Promise<void> {
    const track = usePlayer.getState().queue[index];
    if (!track || !this.audio) return;
    const epoch = ++this.epoch;
    this.intentPlay = autoplay;
    this.seekOnLoad = position;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    usePlayer.setState({
      index,
      current: track,
      status: "loading",
      error: "",
      position,
      duration: track.availability === "preview" ? 0 : track.duration,
      lyrics: emptyLyrics(),
      lyricsError: "",
    });
    this.armTimeout();
    void this.persist();
    this.configureEffects();
    void this.loadLyrics();
    try {
      const resolved = await api.resolveTrack(track.id);
      if (epoch !== this.epoch) return;
      usePlayer.setState((state) => ({
        current: resolved.track,
        queue: state.queue.map((item) =>
          item.id === track.id ? resolved.track : item,
        ),
      }));
      this.configureEffects();
      if (resolved.track.availability === "preview") {
        ++this.lyricsEpoch;
        usePlayer.setState({ lyrics: { ...emptyLyrics(), status: "unsupported" }, lyricsLoading: false, lyricsError: "" });
      }
      this.audio.src = resolved.url;
      this.audio.load();
      this.updateMetadata(resolved.track);
    } catch (error) {
      if (epoch === this.epoch) this.fail(errorMessage(error));
    }
  }

  private async startAudio(): Promise<void> {
    if (!this.audio || !this.intentPlay) return;
    const epoch = this.epoch;
    try {
      await this.graph?.resume();
      if (epoch !== this.epoch || !this.intentPlay) return;
      await this.audio.play();
      if (epoch === this.epoch && this.intentPlay) {
        const track = usePlayer.getState().current;
        if (track)
          void api
            .recordPlay(track.id)
            .then(() => useApp.getState().refresh())
            .catch(() => undefined);
        void this.persist();
      }
    } catch (error) {
      if (
        epoch === this.epoch &&
        this.intentPlay &&
        (!(error instanceof DOMException) || error.name !== "AbortError")
      )
        this.fail(errorMessage(error));
    }
  }

  async play(): Promise<void> {
    const state = usePlayer.getState();
    if (!state.current && state.queue.length) {
      await this.select(0);
      return;
    }
    if (!state.current) return;
    if (state.status === "error") {
      await this.select(state.index, true, state.position);
      return;
    }
    this.intentPlay = true;
    if (this.audio?.readyState) {
      if (this.audio.ended) this.audio.currentTime = 0;
      await this.startAudio();
    }
  }

  pause(): void {
    this.intentPlay = false;
    this.audio?.pause();
    const state = usePlayer.getState();
    if (state.current && state.status !== "error" && this.audio?.readyState)
      usePlayer.setState({ status: "paused" });
    void this.persist();
  }

  toggle(): void {
    if (this.intentPlay) this.pause();
    else void this.play();
  }

  playTrack(track: Track, context?: Track[]): void {
    if (!playable(track)) {
      useApp.getState().notify("此曲目只能在原平台按权限播放", "info");
      return;
    }
    if (context) {
      const queue = context.filter(playable);
      usePlayer.setState({ queue });
      void this.select(queue.findIndex((item) => item.id === track.id));
    } else {
      let index = usePlayer
        .getState()
        .queue.findIndex((item) => item.id === track.id);
      if (index < 0) {
        index = usePlayer.getState().queue.length;
        usePlayer.setState((state) => ({ queue: [...state.queue, track] }));
      }
      void this.select(index);
    }
  }

  playAll(tracks: Track[], shuffle = false): void {
    const queue = tracks.filter(playable);
    if (!queue.length) {
      useApp.getState().notify("当前没有可播放的曲目", "info");
      return;
    }
    if (shuffle) usePlayer.setState({ mode: "shuffle" });
    usePlayer.setState({ queue });
    void this.select(shuffle ? Math.floor(Math.random() * queue.length) : 0);
  }

  next(automatic = false): void {
    const state = usePlayer.getState();
    const index = nextIndex(
      state.queue.length,
      state.index,
      state.mode,
      automatic,
    );
    if (index >= 0) void this.select(index);
    else this.pause();
  }

  previous(): void {
    const state = usePlayer.getState();
    if (!state.queue.length) return;
    if (state.position > 3) {
      this.seek(0);
      return;
    }
    void this.select(
      (state.index - 1 + state.queue.length) % state.queue.length,
    );
  }

  seek(position: number): void {
    if (!this.audio || !Number.isFinite(position)) return;
    const duration = usePlayer.getState().duration;
    const target = Math.max(
      0,
      Math.min(
        position,
        duration || usePlayer.getState().current?.duration || 0,
      ),
    );
    if (this.audio.readyState) this.audio.currentTime = target;
    else this.seekOnLoad = target;
    usePlayer.setState({ position: target });
    void this.persist();
  }

  volume(volume: number): void {
    const value = Math.max(0, Math.min(1, volume));
    if (this.audio) {
      this.audio.volume = value;
      if (value > 0) this.audio.muted = false;
    }
    usePlayer.setState({
      volume: value,
      ...(value > 0 ? { muted: false } : {}),
    });
    void this.persist();
  }

  mute(): void {
    const muted = !usePlayer.getState().muted;
    if (this.audio) this.audio.muted = muted;
    usePlayer.setState({ muted });
    void this.persist();
  }

  mode(mode: PlayMode): void {
    usePlayer.setState({ mode });
    void this.persist();
  }

  enqueue(track: Track, next = false): void {
    if (!playable(track)) {
      useApp.getState().notify("此曲目暂不能加入播放队列", "info");
      return;
    }
    const state = usePlayer.getState();
    const queue = [...state.queue];
    queue.splice(
      next && state.index >= 0 ? state.index + 1 : queue.length,
      0,
      track,
    );
    usePlayer.setState({ queue });
    void this.persist();
    useApp.getState().notify(next ? "已设为下一首播放" : "已加入播放队列");
  }

  remove(index: number): void {
    const state = usePlayer.getState();
    const queue = state.queue.filter((_track, i) => i !== index);
    if (!queue.length) {
      this.clear();
      return;
    }
    usePlayer.setState({ queue });
    if (index === state.index)
      void this.select(Math.min(index, queue.length - 1), this.intentPlay);
    else {
      usePlayer.setState({
        index: index < state.index ? state.index - 1 : state.index,
      });
      void this.persist();
    }
  }

  removeTrack(id: string): void {
    const state = usePlayer.getState();
    for (let i = state.queue.length - 1; i >= 0; i--)
      if (state.queue[i].id === id) this.remove(i);
  }

  move(from: number, to: number): void {
    const state = usePlayer.getState();
    const tagged = state.queue.map((track, index) => ({ track, index }));
    const ordered = moveItem(tagged, from, to);
    usePlayer.setState({
      queue: ordered.map((item) => item.track),
      index: ordered.findIndex((item) => item.index === state.index),
    });
    void this.persist();
  }

  clear(): void {
    ++this.epoch;
    ++this.lyricsEpoch;
    clearTimeout(this.loadTimer);
    this.intentPlay = false;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
    usePlayer.setState({
      queue: [],
      index: -1,
      current: null,
      status: "idle",
      position: 0,
      duration: 0,
      lyrics: emptyLyrics(),
      lyricsLoading: false,
      lyricsError: "",
      error: "",
    });
    this.configureEffects();
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
    void this.persist();
  }

  persist(): Promise<void> {
    const state = usePlayer.getState();
    const value: PlaybackState = {
      queue: state.queue.map((track) => track.id),
      currentId: state.current?.id ?? null,
      index: state.index,
      position: state.position,
      volume: state.volume,
      muted: state.muted,
      mode: state.mode,
    };
    this.savedAt = Date.now();
    api.playbackCheckpoint(value);
    // Serialize snapshots so a slow IPC response cannot overwrite a newer queue.
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => api.savePlayback(value))
      .catch((error) => {
        useApp
          .getState()
          .notify(`播放状态未保存：${errorMessage(error)}`, "error");
      });
    return this.saving;
  }

  async loadLyrics(online = false, refresh = false): Promise<void> {
    const track = usePlayer.getState().current;
    if (!track) return;
    const epoch = ++this.lyricsEpoch;
    usePlayer.setState({ lyricsLoading: true, lyricsError: "" });
    try {
      const lyrics = await api.lyrics(track.id, online, refresh);
      if (epoch === this.lyricsEpoch) usePlayer.setState({ lyrics, lyricsLoading: false });
    } catch (error) {
      if (epoch === this.lyricsEpoch) usePlayer.setState({ lyricsLoading: false, lyricsError: errorMessage(error) });
    }
  }

  setAudioEffects(update: Partial<AudioEffectsSettings>): void {
    const effects = { ...usePlayer.getState().effects, ...update };
    usePlayer.setState({ effects });
    this.configureEffects();
    api.audioEffectsCheckpoint(effects);
    clearTimeout(this.effectsTimer);
    this.effectsTimer = setTimeout(() => { void this.persistEffects(); }, 450);
  }

  setBand(index: number, value: number): void {
    if (index < 0 || index >= DEFAULT_AUDIO_EFFECTS.bands.length || !Number.isFinite(value)) return;
    const state = usePlayer.getState();
    const bands = effectiveEffects({ ...state.effects, enabled: true }, state.current).bands;
    bands[index] = Math.max(-12, Math.min(12, value));
    this.setAudioEffects({ preset: "custom", bands });
  }

  spectrum() { return this.graph?.read() ?? null; }

  private configureEffects(): void {
    const { effects, current } = usePlayer.getState();
    if (this.graph) usePlayer.setState({ effectsHeadroom: this.graph.configure(effects, current) });
  }

  private persistEffects(): Promise<void> {
    clearTimeout(this.effectsTimer);
    const effects = usePlayer.getState().effects;
    api.audioEffectsCheckpoint(effects);
    this.savingEffects = this.savingEffects.catch(() => undefined).then(() => api.saveAudioEffects(effects)).then(() => undefined)
      .catch((error) => useApp.getState().notify(`音效未保存：${errorMessage(error)}`, "error"));
    return this.savingEffects;
  }

  private broadcast(state: PlayerStore): void {
    const value: MiniState = {
      current: state.current,
      status: state.status,
      position: state.position,
      duration: state.duration,
      volume: state.volume,
      muted: state.muted,
    };
    api.miniBroadcast(value);
    api.playerSummary({
      title: state.current?.title ?? "声迹",
      artist: state.current?.artist ?? "",
      playing: state.status === "playing",
      hasTrack: Boolean(state.current),
    });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState =
        state.status === "playing"
          ? "playing"
          : state.current
            ? "paused"
            : "none";
      if (state.duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration: state.duration,
            position: Math.min(state.duration, state.position),
            playbackRate: 1,
          });
        } catch {
          /* Some codecs do not expose a seekable timeline. */
        }
      }
    }
  }

  private updateMetadata(track: Track): void {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: track.artwork ? [{ src: track.artwork }] : [],
      });
    } catch {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
      });
    }
  }

  private installMediaSession(): void {
    if (!("mediaSession" in navigator)) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      [
        "play",
        () => {
          void this.play();
        },
      ],
      ["pause", () => this.pause()],
      ["previoustrack", () => this.previous()],
      ["nexttrack", () => this.next()],
      ["seekto", (event) => this.seek(event.seekTime ?? 0)],
      [
        "seekbackward",
        (event) =>
          this.seek(usePlayer.getState().position - (event.seekOffset ?? 5)),
      ],
      [
        "seekforward",
        (event) =>
          this.seek(usePlayer.getState().position + (event.seekOffset ?? 5)),
      ],
      ["stop", () => this.pause()],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* Unsupported OS actions are optional. */
      }
    }
  }
}

export const player = new PlaybackEngine();
