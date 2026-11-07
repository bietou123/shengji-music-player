import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import './build.mjs';

const server = await createServer();
await server.listen();
const address = server.resolvedUrls.local[0];
console.log(`Shengji renderer: ${address}`);
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, SHENGJI_DEV_URL: address } });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
process.on('SIGINT', () => child.kill());
