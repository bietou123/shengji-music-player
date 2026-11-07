import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import rangeParser from 'range-parser';
import { lookup } from 'mime-types';
import type { LibraryDatabase } from './database';
import { fetchMedia, validateMediaUrl } from './network';
import type { SourceId } from '../shared/types';

export class RemoteMedia {
  private grants = new Map<string, { url: string; source: SourceId }>();
  constructor(private request: typeof fetch = fetch) {}

  authorize(url: string, source: SourceId): string {
    const safe = validateMediaUrl(url, source);
    const token = randomUUID();
    this.grants.set(token, { url: safe, source });
    while (this.grants.size > 200) this.grants.delete(this.grants.keys().next().value!);
    return `shengji-media://stream/${token}`;
  }

  async response(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.protocol !== 'shengji-media:' || url.hostname !== 'stream' || url.username || url.password || url.port || url.search)
      return new Response(null, { status: 404 });
    const grant = this.grants.get(url.pathname.slice(1));
    if (!grant) return new Response(null, { status: 404 });
    const headers = new Headers({ Accept: 'audio/*,application/octet-stream;q=0.9', Referer: grant.source === 'netease' ? 'https://music.163.com/' : new URL(grant.url).origin });
    const range = request.headers.get('range');
    if (range) {
      if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response(null, { status: 416 });
      headers.set('Range', range);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      // A grant can only be created from an adapter's validated, permitted stream.
      const upstream = await fetchMedia(grant.url, grant.source, { method: request.method, headers, signal: AbortSignal.any([request.signal, controller.signal]) }, this.request);
      clearTimeout(timer);
      const responseHeaders = new Headers({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      const contentType = upstream.headers.get('content-type') ?? '';
      if (upstream.ok && !/^(?:audio\/|application\/(?:octet-stream|ogg))/i.test(contentType)) {
        await upstream.body?.cancel();
        return new Response(null, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      if (request.method === 'HEAD') await upstream.body?.cancel();
      return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch {
      return new Response(null, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
    } finally { clearTimeout(timer); }
  }
}

export async function mediaResponse(request: Request, database: LibraryDatabase, artworkDir: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'shengji-media:' || url.username || url.password || url.port) return new Response(null, { status: 404 });
    const id = decodeURIComponent(url.pathname.slice(1));
    const track = database.getTrack(id);
    if (!track || track.source !== 'local') return new Response(null, { status: 404 });
    let file: string | undefined;
    if (url.hostname === 'track') file = track.filePath;
    else if (url.hostname === 'cover') {
      const name = (await readdir(artworkDir)).find((entry) => entry === `${track.sourceId}.jpg` || entry === `${track.sourceId}.png` || entry === `${track.sourceId}.webp`);
      if (name) file = path.join(artworkDir, name);
    }
    if (!file) return new Response(null, { status: 404 });
    const info = await stat(file);
    if (!info.isFile() || !info.size) return new Response(null, { status: 404 });
    let start = 0, end = info.size - 1, status = 200;
    const range = request.headers.get('range');
    if (range) {
      const ranges = rangeParser(info.size, range);
      if (typeof ranges === 'number' || ranges.type !== 'bytes' || ranges.length !== 1) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
      start = ranges[0].start; end = ranges[0].end; status = 206;
    }
    const headers = new Headers({ 'Content-Type': lookup(file) || 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>, { status, headers });
  } catch { return new Response(null, { status: 404 }); }
}
