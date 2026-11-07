import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { VisualFrameClock } from '../src/visual-runtime';

function frames(context: TestContext) {
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    pending.set(++id, callback);
    return id;
  } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => pending.delete(id) });
  context.after(() => {
    if (originalRequest) Object.defineProperty(globalThis, 'requestAnimationFrame', originalRequest);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (originalCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', originalCancel);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  return {
    pending,
    advance(time = 16) {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback(time));
    },
  };
}

test('visual tasks share one RAF and stop once each pending task draws', (context) => {
  const raf = frames(context);
  const clock = new VisualFrameClock();
  const draws: number[] = [];
  const first = clock.add((time) => { draws.push(time); });
  clock.add((time) => { draws.push(time + 1); });
  assert.equal(raf.pending.size, 0, 'An unshown window must not schedule drawing');
  clock.configure({ windowVisible: true });
  first.request(); first.request();
  assert.equal(raf.pending.size, 1);
  raf.advance(32);
  assert.deepEqual(draws, [32, 33]);
  assert.equal(raf.pending.size, 0);
  first.request();
  assert.equal(raf.pending.size, 1);
  raf.advance(48);
  assert.deepEqual(draws, [32, 33, 48]);
  assert.equal(raf.pending.size, 0);
});

test('a moving task requests exactly one subsequent frame until it settles', (context) => {
  const raf = frames(context);
  const clock = new VisualFrameClock();
  let draws = 0;
  clock.configure({ windowVisible: true });
  clock.add(() => ++draws < 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(raf.pending.size, 1);
    raf.advance(i * 16);
  }
  assert.equal(draws, 3);
  assert.equal(raf.pending.size, 0);
});

test('native or page invisibility cancels RAF and restores pending tasks only when both are visible', (context) => {
  const raf = frames(context);
  const clock = new VisualFrameClock();
  let draws = 0;
  const task = clock.add(() => { draws++; });
  clock.configure({ windowVisible: true });
  assert.equal(raf.pending.size, 1);
  clock.configure({ windowVisible: false });
  assert.equal(raf.pending.size, 0);
  task.request();
  clock.configure({ pageVisible: false, windowVisible: true });
  assert.equal(clock.visible, false);
  assert.equal(raf.pending.size, 0);
  clock.configure({ pageVisible: true });
  assert.equal(raf.pending.size, 1);
  raf.advance();
  assert.equal(draws, 1);
  assert.equal(raf.pending.size, 0);
  clock.configure({ pageVisible: false });
  task.request();
  assert.equal(raf.pending.size, 0);
  clock.configure({ pageVisible: true });
  raf.advance();
  assert.equal(draws, 2);
});

test('disposed tasks cannot keep or restart a pending RAF', (context) => {
  const raf = frames(context);
  const clock = new VisualFrameClock();
  clock.configure({ windowVisible: true });
  let draws = 0;
  const task = clock.add(() => { draws++; return true; });
  task.dispose();
  assert.equal(raf.pending.size, 0);
  task.request();
  assert.equal(raf.pending.size, 0);
  raf.advance();
  assert.equal(draws, 0);
  const moving = clock.add(() => { draws++; return true; });
  raf.advance();
  assert.equal(draws, 1);
  assert.equal(raf.pending.size, 1);
  moving.dispose();
  assert.equal(raf.pending.size, 0);
});

test('a failed visual task stops without breaking another moving task', (context) => {
  const raf = frames(context);
  context.mock.method(console, 'warn', () => undefined);
  const clock = new VisualFrameClock();
  clock.configure({ windowVisible: true });
  let failures = 0, draws = 0;
  clock.add(() => { failures++; throw new Error('Test context loss'); });
  clock.add(() => ++draws < 2);
  raf.advance();
  assert.equal(failures, 1);
  assert.equal(draws, 1);
  assert.equal(raf.pending.size, 1);
  raf.advance();
  assert.equal(failures, 1, 'A failed task must not retry every frame');
  assert.equal(draws, 2);
  assert.equal(raf.pending.size, 0);
});

test('tasks added or removed during a draw preserve single-RAF scheduling', (context) => {
  const raf = frames(context);
  const clock = new VisualFrameClock();
  clock.configure({ windowVisible: true });
  const draws: string[] = [];
  let removed: { dispose(): void };
  clock.add(() => {
    draws.push('first');
    removed.dispose();
    clock.add(() => { draws.push('new'); });
  });
  removed = clock.add(() => { draws.push('removed'); });
  raf.advance();
  assert.deepEqual(draws, ['first']);
  assert.equal(raf.pending.size, 1);
  raf.advance();
  assert.deepEqual(draws, ['first', 'new']);
  assert.equal(raf.pending.size, 0);
});

test('motion and visibility subscribers are notified only for effective state changes', (context) => {
  const raf = frames(context);
  const clock = new VisualFrameClock();
  let notifications = 0;
  const unsubscribe = clock.subscribe(() => { notifications++; });
  clock.configure({ motion: false });
  assert.equal(clock.motion, false);
  assert.equal(notifications, 1);
  clock.configure({ motion: false, windowVisible: false });
  assert.equal(notifications, 1);
  clock.configure({ windowVisible: true });
  assert.equal(notifications, 2);
  clock.configure({ pageVisible: false });
  assert.equal(notifications, 3);
  unsubscribe();
  clock.configure({ pageVisible: true, motion: true });
  assert.equal(notifications, 3);
  assert.equal(raf.pending.size, 0, 'State changes alone must not start idle RAF loops');
});
