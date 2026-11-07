export function networkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时';
    if (error.message.startsWith('HTTP ')) return `服务返回 ${error.message}`;
    if (error.message === 'fetch failed') return '连接失败';
    return error.message.slice(0, 140);
  }
  return '连接失败';
}

class HttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

interface ClientOptions { timeoutMs?: number; retryDelayMs?: number; }

export class JsonClient {
  private cache = new Map<string, { time: number; data: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private request: typeof fetch = fetch, private options: ClientOptions = {}) {}

  async get<T>(url: string, ttl = 180_000, validate?: (data: T) => void): Promise<T> {
    const cached = this.cache.get(url);
    if (ttl > 0 && cached && Date.now() - cached.time < ttl) {
      validate?.(cached.data as T);
      return cached.data as T;
    }
    const existing = this.inflight.get(url);
    if (existing) {
      const data = await existing as T;
      validate?.(data);
      return data;
    }
    const pending = this.fetchJson<T>(url, ttl, validate).finally(() => this.inflight.delete(url));
    this.inflight.set(url, pending);
    return pending;
  }

  private async fetchJson<T>(url: string, ttl: number, validate?: (data: T) => void): Promise<T> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.request(url, {
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 12_000),
          headers: { Accept: 'application/json', 'User-Agent': 'Shengji/1.0', Referer: new URL(url).origin },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpError(response.status);
        }
        break;
      } catch (error) {
        const transient = error instanceof HttpError ? error.status >= 500 :
          error instanceof TypeError || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
        if (attempt || !transient) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 350));
      }
    }
    if (!response) throw new Error('连接失败');
    if (Number(response.headers.get('content-length') ?? 0) > 15_000_000) {
      await response.body?.cancel();
      throw new Error('响应过大');
    }
    const text = await response.text();
    if (text.length > 15_000_000) throw new Error('响应过大');
    const data = JSON.parse(text) as T;
    validate?.(data);
    if (ttl > 0) {
      this.cache.set(url, { time: Date.now(), data });
      while (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value!);
    }
    return data;
  }
}

export function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function validateMediaUrl(value: string, source: string): string {
  const safe = httpsUrl(value);
  if (!safe) throw new Error('音源地址无效');
  const url = new URL(safe);
  if (url.port && url.port !== '443') throw new Error('音源端口不受信任');
  const host = url.hostname;
  const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  const allowed = source === 'netease' ? matches('music.126.net') : source === 'itunes' ? matches('itunes.apple.com') || matches('mzstatic.com') : source === 'archive' ? matches('archive.org') : source === 'jamendo' ? matches('jamendo.com') : false;
  if (!allowed) throw new Error('音源域名不受信任');
  return safe;
}

export async function fetchMedia(value: string, source: string, options: RequestInit = {}, request: typeof fetch = fetch): Promise<Response> {
  let url = validateMediaUrl(value, source);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await request(url, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects === 4) throw new Error('音源重定向无效');
    url = validateMediaUrl(new URL(location, url).href, source);
  }
  throw new Error('音源重定向无效');
}
