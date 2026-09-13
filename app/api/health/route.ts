import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({
    ok: true,
    project: 'zhijing',
    mockMode: process.env.ZHIJING_MOCK_MODE !== 'false',
  });
}
