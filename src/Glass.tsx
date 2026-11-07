import { useEffect, useRef, useState } from 'react';
import { LinearFilter, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, SRGBColorSpace, Texture, Vector2, WebGLRenderer } from 'three';
import type { VisualState } from '../shared/types';
import { api } from './api';
import { visualFrames } from './visual-runtime';

const MAX_SURFACES = 8;
const MAX_PIXELS = 1_500_000;

const vertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// DOM blur is Chromium's job. This shader lights the rim and, only where an
// actual album-image underlay exists, refracts that same image near the edge.
const fragmentShader = `
varying vec2 vUv;
uniform vec2 uSize;
uniform float uRadius;
uniform vec2 uLight;
uniform float uDark;
uniform float uOpacity;
uniform sampler2D uCover;
uniform float uUseCover;
uniform float uCoverOpacity;
uniform vec2 uCoverScale;
uniform vec2 uCoverOffset;
uniform vec2 uCoverPixel;

float roundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = (vUv - 0.5) * uSize;
  vec2 halfSize = uSize * 0.5 - 0.8;
  float radius = min(uRadius, min(halfSize.x, halfSize.y));
  float distance = roundedBox(p, halfSize, radius);
  float depth = -distance;
  if (depth < -0.7 || depth > 9.0) discard;

  vec2 normal = normalize(vec2(
    roundedBox(p + vec2(0.35, 0.0), halfSize, radius) - roundedBox(p - vec2(0.35, 0.0), halfSize, radius),
    roundedBox(p + vec2(0.0, 0.35), halfSize, radius) - roundedBox(p - vec2(0.0, 0.35), halfSize, radius)
  ) + vec2(0.00001));
  float edge = exp(-abs(distance) * 1.3);
  float bevel = 1.0 - smoothstep(0.0, 8.0, max(depth, 0.0));
  vec3 light = normalize(vec3(uLight, 1.0));
  vec3 surfaceNormal = normalize(vec3(normal * 0.85, 0.65));
  float specular = pow(max(dot(surfaceNormal, light), 0.0), 12.0);
  float fresnel = pow(1.0 - surfaceNormal.z, 3.0);
  float alpha = edge * mix(0.20, 0.29, uDark) + bevel * specular * 0.19 + bevel * fresnel * 0.11;
  vec3 color = vec3(1.0);

  if (uUseCover > 0.5) {
    vec2 baseUv = (vUv - 0.5) * uCoverScale + uCoverOffset;
    vec2 bend = normal * uCoverPixel * (5.0 + specular * 3.0) * bevel;
    vec2 uv = clamp(baseUv + bend, vec2(0.001), vec2(0.999));
    vec3 refracted = vec3(
      texture2D(uCover, clamp(uv + normal * uCoverPixel * 0.55, 0.001, 0.999)).r,
      texture2D(uCover, uv).g,
      texture2D(uCover, clamp(uv - normal * uCoverPixel * 0.55, 0.001, 0.999)).b
    );
    float transmission = bevel * mix(0.22, 0.30, uDark) * uCoverOpacity;
    color = mix(refracted, color, clamp(alpha / (alpha + transmission + 0.001), 0.0, 1.0));
    alpha += transmission;
  }

  float coverage = 1.0 - smoothstep(-0.7, 0.7, distance);
  gl_FragColor = vec4(color, clamp(alpha * coverage * uOpacity, 0.0, 0.72));
  #include <colorspace_fragment>
}`;

interface Surface {
  element: HTMLElement | null;
  mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  light: Vector2;
}

class GlassOptics {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(0, 1, 1, 0, 0.1, 10);
  private geometry = new PlaneGeometry(1, 1);
  private surfaces: Surface[] = [];
  private texture: Texture | null = null;
  private textureKey = '';
  private imageSize = new Vector2(1, 1);
  private backdrop: HTMLElement | null = null;
  private backdropImage: HTMLImageElement | null = null;
  private pointer = new Vector2(-10000, -10000);
  private activityUntil = 0;
  private dirty = true;
  private lost = false;
  private disposed = false;
  private width = 0;
  private height = 0;
  private ratio = 0;
  private frame = 0;
  private lastTime = 0;
  private pointerNearGlass = false;
  private task: ReturnType<typeof visualFrames.add>;
  private observer: MutationObserver;
  private resize: ResizeObserver;
  private unsubscribe: () => void;
  private removers: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!context) throw new Error('WebGL2 unavailable');
    this.renderer = new WebGLRenderer({ canvas, context, alpha: true, antialias: false, depth: false, stencil: false });
    this.renderer.setClearColor(0, 0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.debug.onShaderError = () => {
      this.lost = true;
      this.fallback('shader-failed');
    };
    this.camera.position.z = 1;
    this.frame = Number(canvas.dataset.frame ?? 0);
    canvas.dataset.renderer = 'webgl2';
    canvas.dataset.fallbackReason = '';
    this.task = visualFrames.add((time) => this.draw(time));
    this.unsubscribe = visualFrames.subscribe(() => {
      canvas.dataset.active = String(!this.lost && visualFrames.visible);
      if (!visualFrames.motion) this.pointer.set(-10000, -10000);
      this.invalidate();
    });
    this.observer = new MutationObserver(() => this.invalidate());
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-glass-surface', 'data-state', 'inert', 'data-open', 'src', 'data-glass-image'] });
    this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
    this.resize = new ResizeObserver(() => this.invalidate());
    this.resize.observe(document.body);

    const listen = (target: EventTarget, name: string, listener: EventListener, capture = false) => {
      target.addEventListener(name, listener, { capture, passive: true });
      this.removers.push(() => target.removeEventListener(name, listener, capture));
    };
    listen(window, 'resize', () => this.invalidate());
    listen(document, 'scroll', () => this.invalidate(), true);
    listen(document, 'load', () => this.invalidate(), true);
    listen(document, 'pointermove', (event) => {
      if (!visualFrames.motion || !visualFrames.visible) return;
      const pointer = event as PointerEvent;
      const near = this.surfaces.some(({ element }) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return pointer.clientX >= rect.left - 25 && pointer.clientX <= rect.right + 25 && pointer.clientY >= rect.top - 25 && pointer.clientY <= rect.bottom + 25;
      });
      if (near) this.pointer.set(pointer.clientX, pointer.clientY);
      else this.pointer.set(-10000, -10000);
      if (near || this.pointerNearGlass) this.animate(320);
      this.pointerNearGlass = near;
    });
    listen(document, 'pointerleave', () => {
      this.pointer.set(-10000, -10000);
      if (this.pointerNearGlass) this.animate(320);
      this.pointerNearGlass = false;
    });
    listen(document, 'pointerdown', () => this.animate(340));
    listen(document, 'pointerup', () => this.animate(420));
    listen(document, 'input', () => this.animate(220));
    listen(document, 'transitionrun', (event) => {
      if (['transform', 'opacity'].includes((event as TransitionEvent).propertyName)) this.animate(460);
    });
    listen(document, 'animationstart', (event) => {
      if (['glass-in', 'glass-out', 'control-in', 'track-in', 'view-enter', 'artwork-in'].includes((event as AnimationEvent).animationName)) this.animate(460);
    });
    const loss = (event: Event) => { event.preventDefault(); this.lost = true; this.fallback('context-lost'); };
    const restore = () => {
      this.lost = false;
      this.textureKey = '';
      canvas.dataset.renderer = 'webgl2';
      canvas.dataset.fallbackReason = '';
      canvas.style.visibility = '';
      document.documentElement.dataset.glass = 'on';
      this.invalidate();
    };
    canvas.addEventListener('webglcontextlost', loss);
    canvas.addEventListener('webglcontextrestored', restore);
    this.removers.push(() => canvas.removeEventListener('webglcontextlost', loss), () => canvas.removeEventListener('webglcontextrestored', restore));
    this.invalidate();
  }

  private fallback(reason: string): void {
    this.canvas.dataset.renderer = 'fallback';
    this.canvas.dataset.fallbackReason = reason;
    this.canvas.dataset.active = 'false';
    this.canvas.style.visibility = 'hidden';
    document.documentElement.dataset.glass = 'fallback';
  }

  private invalidate(): void {
    this.dirty = true;
    if (!this.disposed) this.task.request();
  }

  private animate(duration: number): void {
    if (visualFrames.motion) this.activityUntil = Math.max(this.activityUntil, performance.now() + duration);
    if (!this.disposed) this.task.request();
  }

  private collect(): void {
    const foreground = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')].at(-1)
      ?? [...document.querySelectorAll<HTMLElement>('.dropdown-menu')].at(-1);
    const elements = [...document.querySelectorAll<HTMLElement>('[data-glass-surface]')]
      .filter((element) => !foreground || foreground === element || foreground.contains(element))
      .filter((element) => (!element.closest('[inert]') || element.dataset.state === 'closing') && getComputedStyle(element).visibility !== 'hidden')
      .slice(0, MAX_SURFACES);
    // Keep a bounded pool: UI changes must not reallocate or recompile shaders.
    for (let index = 0; index < Math.max(this.surfaces.length, elements.length); index++) {
      const element = elements[index] ?? null;
      let surface = this.surfaces[index];
      if (!surface) {
        const material = new ShaderMaterial({
        vertexShader, fragmentShader, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
        uniforms: {
          uSize: { value: new Vector2() }, uRadius: { value: 8 }, uLight: { value: new Vector2(-0.45, 0.75) },
          uDark: { value: 0 }, uOpacity: { value: 1 }, uCover: { value: null }, uUseCover: { value: 0 }, uCoverOpacity: { value: 1 },
          uCoverScale: { value: new Vector2(1, 1) }, uCoverOffset: { value: new Vector2(0.5, 0.5) }, uCoverPixel: { value: new Vector2() },
        },
        });
        const mesh = new Mesh(this.geometry, material);
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        surface = { element: null, mesh, light: new Vector2(-0.45, 0.75) };
        this.surfaces.push(surface);
      }
      if (surface.element !== element) {
        if (surface.element) this.resize.unobserve(surface.element);
        if (element) this.resize.observe(element);
        surface.element = element;
        surface.light.set(-0.45, 0.75);
      }
      surface.mesh.visible = Boolean(element);
    }
    this.dirty = false;
  }

  private updateTexture(): void {
    this.backdrop = document.querySelector<HTMLElement>('[data-glass-backdrop]');
    const image = this.backdrop?.querySelector<HTMLImageElement>('img[data-glass-image="sampleable"]');
    this.backdropImage = image ?? null;
    const key = image?.complete && image.naturalWidth ? image.currentSrc || image.src : '';
    if (this.textureKey === key) return;
    this.textureKey = key;
    this.texture?.dispose();
    this.texture = null;
    if (image && key) {
      try {
        // Resize the source image once, never the DOM. The shader and underlay
        // share its object-fit cover mapping; no arbitrary page pixels are read.
        const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
        const source = document.createElement('canvas');
        source.width = Math.max(1, Math.round(image.naturalWidth * scale));
        source.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = source.getContext('2d');
        if (context) {
          context.drawImage(image, 0, 0, source.width, source.height);
          context.getImageData(0, 0, 1, 1);
          this.texture = new Texture(source);
          this.texture.colorSpace = SRGBColorSpace;
          this.texture.minFilter = LinearFilter;
          this.texture.magFilter = LinearFilter;
          this.texture.generateMipmaps = false;
          this.texture.needsUpdate = true;
          this.imageSize.set(image.naturalWidth, image.naturalHeight);
        }
      } catch { this.texture = null; }
    }
    this.canvas.dataset.texture = this.texture ? 'cover' : 'none';
  }

  private draw(time: number): boolean {
    if (this.disposed || this.lost || !visualFrames.visible) return false;
    if (this.dirty) this.collect();
    this.updateTexture();
    const width = innerWidth, height = innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(MAX_PIXELS / (width * height)));
    if (width !== this.width || height !== this.height || ratio !== this.ratio) {
      this.width = width; this.height = height; this.ratio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(width, height, false);
      this.camera.right = width; this.camera.top = height;
      this.camera.updateProjectionMatrix();
    }
    const dark = document.documentElement.dataset.theme === 'dark';
    const backdrop = this.backdrop?.getBoundingClientRect();
    const coverOpacity = this.backdropImage ? Number(getComputedStyle(this.backdropImage).opacity) : 0;
    const blend = visualFrames.motion ? 1 - Math.exp(-Math.min(64, this.lastTime ? time - this.lastTime : 16.7) / 45) : 1;
    this.lastTime = time;
    let visible = 0;
    for (const surface of this.surfaces) {
      if (!surface.element) { surface.mesh.visible = false; continue; }
      const rect = surface.element.getBoundingClientRect();
      const style = getComputedStyle(surface.element);
      const active = rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height && style.visibility !== 'hidden';
      surface.mesh.visible = active;
      if (!active) continue;
      visible++;
      const uniforms = surface.mesh.material.uniforms;
      surface.mesh.position.set(rect.x + rect.width / 2, height - rect.y - rect.height / 2, 0);
      surface.mesh.scale.set(rect.width, rect.height, 1);
      uniforms.uSize.value.set(rect.width, rect.height);
      uniforms.uRadius.value = parseFloat(style.borderTopLeftRadius) || 8;
      uniforms.uDark.value = dark ? 1 : 0;
      const parent = surface.element.closest('.modal-backdrop');
      uniforms.uOpacity.value = Number(style.opacity) * (parent ? Number(getComputedStyle(parent).opacity) : 1);
      const hovering = this.pointer.x >= rect.left - 25 && this.pointer.x <= rect.right + 25 && this.pointer.y >= rect.top - 25 && this.pointer.y <= rect.bottom + 25;
      const targetX = hovering ? (this.pointer.x - rect.left) / rect.width * 1.8 - 0.9 : -0.45;
      const targetY = hovering ? 0.9 - (this.pointer.y - rect.top) / rect.height * 1.8 : 0.75;
      surface.light.x += (targetX - surface.light.x) * blend;
      surface.light.y += (targetY - surface.light.y) * blend;
      uniforms.uLight.value.copy(surface.light);
      const kind = surface.element.dataset.glassSurface;
      const sample = Boolean(this.texture && backdrop && (kind === 'player' || kind === 'mini'));
      uniforms.uUseCover.value = sample ? 1 : 0;
      uniforms.uCoverOpacity.value = coverOpacity;
      uniforms.uCover.value = sample ? this.texture : null;
      if (sample && backdrop) {
        const coverScale = Math.max(backdrop.width / this.imageSize.x, backdrop.height / this.imageSize.y);
        const imageWidth = this.imageSize.x * coverScale, imageHeight = this.imageSize.y * coverScale;
        uniforms.uCoverScale.value.set(rect.width / imageWidth, rect.height / imageHeight);
        uniforms.uCoverOffset.value.set(0.5 + (rect.x + rect.width / 2 - backdrop.x - backdrop.width / 2) / imageWidth, 0.5 - (rect.y + rect.height / 2 - backdrop.y - backdrop.height / 2) / imageHeight);
        uniforms.uCoverPixel.value.set(1 / imageWidth, 1 / imageHeight);
      }
    }
    this.canvas.dataset.surfaces = String(visible);
    this.canvas.dataset.active = String(visible > 0);
    try {
      this.renderer.render(this.scene, this.camera);
      if (this.lost) return false;
      // This counter records real submissions, not scheduled or idle RAFs.
      this.canvas.dataset.frame = String(++this.frame);
    } catch { this.lost = true; this.fallback('render-failed'); return false; }
    return visible > 0 && visualFrames.motion && time < this.activityUntil;
  }

  dispose(): void {
    this.disposed = true;
    this.task.dispose(); this.unsubscribe();
    this.observer.disconnect(); this.resize.disconnect();
    for (const remove of this.removers) remove();
    for (const surface of this.surfaces) surface.mesh.material.dispose();
    this.texture?.dispose(); this.geometry.dispose(); this.renderer.dispose();
    this.canvas.dataset.active = 'false';
  }
}

export function ArtworkBackdrop({ artwork, kind }: { artwork?: string; kind: 'player' | 'mini' }) {
  const [displayOnly, setDisplayOnly] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadedSource, setLoadedSource] = useState('');
  useEffect(() => { setDisplayOnly(false); setFailed(false); }, [artwork]);
  return <div className={`glass-backdrop ${kind}-artwork-backdrop`} data-glass-backdrop={kind} aria-hidden="true">
    {artwork && !failed && <img key={`${artwork}:${displayOnly}`} src={artwork} crossOrigin={displayOnly ? undefined : 'anonymous'} referrerPolicy="no-referrer" data-loaded={loadedSource === artwork} data-glass-image={displayOnly ? 'display-only' : 'sampleable'} onLoad={() => setLoadedSource(artwork)} onError={() => displayOnly ? setFailed(true) : setDisplayOnly(true)} />}
  </div>;
}

export function VisualLayer() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [environment, setEnvironment] = useState<VisualState | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    let current: VisualState | null = null;
    let disposed = false, updates = 0;
    const apply = () => {
      if (!current) return;
      root.dataset.theme = current.settings.theme === 'system' ? (dark.matches ? 'dark' : 'light') : current.settings.theme;
      root.dataset.motion = current.settings.motionEffects && !reduced.matches ? 'on' : 'off';
      root.dataset.glass = current.settings.glassEffects ? (canvas.current?.dataset.renderer === 'fallback' ? 'fallback' : 'on') : 'off';
      root.dataset.windowVisible = String(current.visible && !document.hidden);
      visualFrames.configure({ windowVisible: current.visible, pageVisible: !document.hidden, motion: current.settings.motionEffects && !reduced.matches });
    };
    const update = (state: VisualState) => {
      if (disposed) return;
      updates++; current = state; apply(); setEnvironment(state);
    };
    const unsubscribe = api.onVisualState(update);
    const revision = updates;
    void api.visualState().then((state) => { if (updates === revision) update(state); }).catch(() => {
      if (canvas.current) { canvas.current.dataset.renderer = 'fallback'; canvas.current.dataset.active = 'false'; }
      root.dataset.glass = 'fallback';
      root.dataset.motion = 'off';
    });
    reduced.addEventListener('change', apply);
    dark.addEventListener('change', apply);
    document.addEventListener('visibilitychange', apply);
    return () => {
      disposed = true; unsubscribe();
      reduced.removeEventListener('change', apply); dark.removeEventListener('change', apply);
      document.removeEventListener('visibilitychange', apply);
      visualFrames.configure({ windowVisible: false });
    };
  }, []);
  const enabled = environment?.settings.glassEffects;
  const hardware = environment?.hardwareAccelerated;
  useEffect(() => {
    const element = canvas.current;
    if (!element || enabled === undefined) return;
    element.dataset.texture = 'none'; element.dataset.surfaces = '0'; element.dataset.active = 'false';
    element.style.visibility = '';
    if (!enabled || !hardware) {
      element.dataset.renderer = 'fallback';
      element.dataset.fallbackReason = !enabled ? 'disabled' : 'hardware-unavailable';
      if (enabled) document.documentElement.dataset.glass = 'fallback';
      return;
    }
    try {
      const optics = new GlassOptics(element);
      document.documentElement.dataset.glass = 'on';
      return () => optics.dispose();
    } catch {
      element.dataset.renderer = 'fallback'; element.dataset.fallbackReason = 'webgl-unavailable';
      document.documentElement.dataset.glass = 'fallback';
    }
  }, [enabled, hardware]);
  return <canvas ref={canvas} className="glass-optics" data-testid="glass-optics" aria-hidden="true" hidden={enabled === false} />;
}
