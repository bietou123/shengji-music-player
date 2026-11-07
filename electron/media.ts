import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import rangeParser from 'range-parser';
import { lookup } from 'mime-types';
import type { LibraryDatabase } from './database';

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
