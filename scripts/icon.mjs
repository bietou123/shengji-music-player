import { mkdir } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AudioLines } from 'lucide-react';

await mkdir('build', { recursive: true });
const mark = renderToStaticMarkup(React.createElement(AudioLines, { color: '#ffffff', width: 170, height: 170, strokeWidth: 2.2 }));
const background = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#158565' } }).png().toBuffer();
const icon = await sharp(background).composite([{ input: Buffer.from(mark), left: 43, top: 43 }]).png().toBuffer();
await writeFile('build/icon.png', icon);
await writeFile('build/icon.ico', await pngToIco(icon));
await mkdir('dist', { recursive: true });
await writeFile('dist/app-icon.png', icon);
