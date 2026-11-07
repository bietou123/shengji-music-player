type FrameTask = (time: number) => boolean | void;
interface Task { draw: FrameTask; pending: boolean; }

// One RAF per renderer. A task opts into another frame only while it has work.
export class VisualFrameClock {
  private tasks = new Set<Task>();
  private listeners = new Set<() => void>();
  private frame = 0;
  private windowVisible = false;
  private pageVisible = true;
  private allowMotion = true;

  get visible(): boolean { return this.windowVisible && this.pageVisible; }
  get motion(): boolean { return this.allowMotion; }

  configure(state: { windowVisible?: boolean; pageVisible?: boolean; motion?: boolean }): void {
    const previousVisible = this.visible;
    const previousMotion = this.motion;
    if (state.windowVisible !== undefined) this.windowVisible = state.windowVisible;
    if (state.pageVisible !== undefined) this.pageVisible = state.pageVisible;
    if (state.motion !== undefined) this.allowMotion = state.motion;
    if (previousVisible === this.visible && previousMotion === this.motion) return;
    if (!this.visible) { cancelAnimationFrame(this.frame); this.frame = 0; }
    for (const listener of this.listeners) listener();
    if (this.visible) for (const task of this.tasks) task.pending = true;
    this.schedule();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(draw: FrameTask): { request(): void; dispose(): void } {
    const task = { draw, pending: true };
    this.tasks.add(task);
    this.schedule();
    return {
      request: () => { if (this.tasks.has(task)) { task.pending = true; this.schedule(); } },
      dispose: () => {
        this.tasks.delete(task);
        if (![...this.tasks].some((entry) => entry.pending)) { cancelAnimationFrame(this.frame); this.frame = 0; }
      },
    };
  }

  private schedule(): void {
    if (this.frame || !this.visible || ![...this.tasks].some((task) => task.pending)) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = 0;
      for (const task of [...this.tasks]) {
        if (!this.visible || !task.pending || !this.tasks.has(task)) continue;
        task.pending = false;
        try { if (task.draw(time)) task.pending = true; }
        catch (error) { console.warn('Visual frame stopped:', error instanceof Error ? error.message : 'unknown'); }
      }
      this.schedule();
    });
  }
}

export const visualFrames = new VisualFrameClock();

export function motionAllowed(): boolean {
  return visualFrames.motion && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
