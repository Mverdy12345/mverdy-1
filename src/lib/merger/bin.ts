// ثنائيات ffmpeg/ffprobe مع ضمان صلاحية التنفيذ (قد تفقد في الاستضافة → ننسخها إلى /tmp بصلاحية 755)
// ملاحظة: لا نستورد حزم ffmpeg-static/ffprobe-static في وقت التشغيل لأن webpack يمسخ __dirname —
// نحلّل المسارات مباشرة (تعمل في dev وعلى Vercel مع outputFileTracingIncludes)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const g = globalThis as unknown as { __ffmpegPath?: string; __ffprobePath?: string };

function firstExisting(candidates: string[]): string | null {
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function ffmpegCandidates(): string[] {
  const bin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const sub = process.platform === "win32" ? "win32/x64/ffmpeg.exe" : `${process.platform}/${process.arch}/ffmpeg`;
  return [
    process.env.FFMPEG_PATH || "",
    path.join(process.cwd(), "node_modules", "ffmpeg-static", bin),
    path.join(process.cwd(), "..", "node_modules", "ffmpeg-static", bin),
    path.join("/var/task/node_modules", "ffmpeg-static", bin),
    // الاحتياط: ثنائي النظام إن وُجد
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ];
}

function ffprobeCandidates(): string[] {
  const exe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const plat = ["linux", "darwin"].includes(process.platform) ? process.platform : "linux";
  const arch = ["arm64", "x64"].includes(process.arch) ? process.arch : "x64";
  return [
    process.env.FFPROBE_PATH || "",
    path.join(process.cwd(), "node_modules", "ffprobe-static", "bin", plat, arch, exe),
    path.join(process.cwd(), "..", "node_modules", "ffprobe-static", "bin", plat, arch, exe),
    path.join("/var/task/node_modules", "ffprobe-static", "bin", plat, arch, exe),
    "/usr/bin/ffprobe",
    "/usr/local/bin/ffprobe",
  ];
}

export async function ensureExecutable(src: string): Promise<string> {
  // صلاحية التنفيذ موجودة؟ استخدمها مباشرة
  try {
    fs.accessSync(src, fs.constants.X_OK);
    return src;
  } catch {
    /* انسخ إلى /tmp */
  }
  const dst = path.join(os.tmpdir(), `${path.basename(src)}-exec`);
  if (!fs.existsSync(dst)) {
    await fs.promises.copyFile(src, dst);
    await fs.promises.chmod(dst, 0o755);
  }
  try {
    fs.accessSync(dst, fs.constants.X_OK);
  } catch {
    await fs.promises.chmod(dst, 0o755);
  }
  return dst;
}

export async function ffmpegPath(): Promise<string> {
  if (g.__ffmpegPath) return g.__ffmpegPath;
  const src = firstExisting(ffmpegCandidates());
  if (!src) throw new Error("ffmpeg غير متوفر — ثبّت ffmpeg-static أو ضبط FFMPEG_PATH");
  const p = await ensureExecutable(src);
  g.__ffmpegPath = p;
  return p;
}

export async function ffprobePath(): Promise<string> {
  if (g.__ffprobePath) return g.__ffprobePath;
  const src = firstExisting(ffprobeCandidates());
  if (!src) throw new Error("ffprobe غير متوفر — ثبّت ffprobe-static أو ضبط FFPROBE_PATH");
  const p = await ensureExecutable(src);
  g.__ffprobePath = p;
  return p;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(bin: string, args: string[], opts: { timeoutMs?: number; onStdoutLine?: (line: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      if (opts.onStdoutLine) {
        for (const line of text.split("\n")) opts.onStdoutLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
