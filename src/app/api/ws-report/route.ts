import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const outPath = path.join(process.cwd(), ".ws-results.json");
    await writeFile(outPath, JSON.stringify(data, null, 2), "utf-8");
    return NextResponse.json({ ok: true, path: outPath });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}


