import { generate } from '../../../src/server/map-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 适配 Vercel/Nodejs 最长执行时间，保证知乎直答与多节点并发搜索完整交付
export const POST = generate;
