// خدمة دمج الفيديو المدمجة — تعمل داخل نفس تطبيق Next.js على Vercel
// التخزين: Turso (chunks 2MB) فقط — لا S3 ولا ملفات دائمة؛ /tmp أثناء المعالجة ثم تنظيف
// القيود: ≤10 مقاطع، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد، حذف تلقائي بعد 24 ساعة
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { q, nowISO, uuid } from "../turso";
import { appendSourceChunk, saveBlobChunks, sourceChunkCount, loadBlobChunks } from "./storage";
import { ffmpegPath, ffprobePath, run } from "./bin";

// الحدود العامة — كلها قابلة للضبط بمتغيرات البيئة
export const LIMITS = {
  maxSources: Number(process.env.MAX_SOURCES || 10),
  sourceMaxMB: Number(process.env.SOURCE_MAX_MB || 200),
  outputMaxMB: Number(process.env.OUTPUT_MAX_MB || 150),
  maxTotalDurationSec: Number(process.env.MAX_TOTAL_DURATION_SEC || 600),
  uploadChunkBytes: 4 * 1024 * 1024, // حد حجم الطلب في Vercel ≈ 4.5MB → أجزاء 4MB
  ttlHours: 24,
};

export type SourceSpec =
  | { kind: "url"; url: string }
  | { kind: "file"; name?: string; size?: number; mime?: string };

export interface JobRow {
  id: string;
  status: "queued" | "uploading" | "processing" | "done" | "failed";
  progress: number;
  error: string | null;
  sources_json: string;
  expected_files: number;
  output_url: string | null;
  output_size: number | null;
  output_duration: number | null;
  output_resolution: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

// قفل تنفيذ process في الذاكرة — يمنع التزامن مع get_task (spec 7.3.3)
const g = globalThis as unknown as { __processInFlight?: Set<string> };
if (!g.__processInFlight) g.__processInFlight = new Set<string>();
const processInFlight = g.__processInFlight;

export function isProcessInFlight(jobId: string): boolean {
  return processInFlight.has(jobId);
}

// ─── إنشاء مهمة دمج ───────────────────────────────────────────────
export async function createJob(sources: SourceSpec[]): Promise<JobRow> {
  const now = nowISO();
  const expires = new Date(Date.now() + LIMITS.ttlHours * 3600 * 1000).toISOString();
  const id = uuid();
  const expectedFiles = sources.filter((s) => s.kind === "file").length;
  const status = expectedFiles > 0 ? "uploading" : "queued";
  await q(
    `INSERT INTO jobs (id, status, progress, sources_json, expected_files, expires_at, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
    [id, status, JSON.stringify(sources), expectedFiles, expires, now, now],
  );
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    await q(`INSERT INTO sources (job_id, seq, kind, url, name, mime, size, uploaded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      i,
      s.kind,
      s.kind === "url" ? s.url : null,
      s.kind === "file" ? s.name ?? `file-${i}` : null,
      s.kind === "file" ? s.mime ?? "video/mp4" : null,
      s.kind === "file" ? s.size ?? 0 : 0,
      s.kind === "file" ? 0 : 1,
    ]);
  }
  return (await getJob(id))!;
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  const res = await q("SELECT * FROM jobs WHERE id = ?", [jobId]);
  return (res.rows[0] as unknown as JobRow) || null;
}

export async function listSourceRows(jobId: string): Promise<{ seq: number; kind: string; url: string | null; name: string | null; mime: string | null; uploaded: number }[]> {
  const res = await q("SELECT seq, kind, url, name, mime, uploaded FROM sources WHERE job_id = ? ORDER BY seq ASC", [jobId]);
  return res.rows as unknown as { seq: number; kind: string; url: string | null; name: string | null; mime: string | null; uploaded: number }[];
}

/** رفع جزء من ملف مصدر (ثنائي ≤4MB) — UI فقط؛ MCP لا يستخدمه */
export async function appendUpload(jobId: string, seq: number, chunkIndex: number, data: Buffer): Promise<void> {
  const job = await getJob(jobId);
  if (!job) throw new JobError(404, "مهمة الدمج غير موجودة");
  if (["done", "failed"].includes(job.status)) throw new JobError(409, "المهمة منتهية — لا يمكن الرفع عليها");
  const rows = await listSourceRows(jobId);
  const src = rows.find((r) => r.seq === seq);
  if (!src || src.kind !== "file") throw new JobError(400, "مصدر غير صالح للرفع");
  await appendSourceChunk(jobId, seq, chunkIndex, data);
}

export async function markSourceUploaded(jobId: string, seq: number): Promise<void> {
  const { count } = await sourceChunkCount(jobId, seq);
  if (count === 0) throw new JobError(400, "لم تُرفَع أي أجزاء لهذا المصدر");
  await q("UPDATE sources SET uploaded = 1 WHERE job_id = ? AND seq = ?", [jobId, seq]);
  const rows = await listSourceRows(jobId);
  const files = rows.filter((r) => r.kind === "file");
  if (files.every((f) => f.uploaded === 1)) {
    await q("UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'uploading'", [nowISO(), jobId]);
  }
}

// ─── حذف شامل (jobs + sources + source_chunks + output_chunks) ────
export async function deleteJob(jobId: string): Promise<void> {
  const db = (await import("../turso")).getDb();
  await db.batch(
    [
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [jobId] },
      { sql: "DELETE FROM jobs WHERE id = ?", args: [jobId] },
    ],
    "write",
  );
}

/** تنظيف كسول للمهام المنتهية (24 ساعة) — يُنفَّذ عند كل إنشاء/دمج + نقطة /api/cron */
export async function cleanupExpired(): Promise<number> {
  const res = await q("SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at < ?", [nowISO()]);
  let n = 0;
  for (const row of res.rows) {
    await deleteJob(String(row.id));
    n++;
  }
  return n;
}

export class JobError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ─── تنزيل مصدر URL إلى /tmp مع حد الحجم بالبايتات ─────────────────
async function downloadSource(url: string, dst: string, onProgress: (frac: number) => void): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new JobError(422, `فشل تنزيل المصدر (HTTP ${res.status}) — تأكد أن الرابط رابط فيديو مباشر عام`);
    const total = Number(res.headers.get("content-length") || 0);
    const maxBytes = LIMITS.sourceMaxMB * 1024 * 1024;
    let written = 0;
    const ws = fs.createWriteStream(dst);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        ws.destroy();
        throw new JobError(413, `حجم المصدر يتجاوز الحد (${LIMITS.sourceMaxMB}MB لكل رابط)`);
      }
      if (!ws.write(Buffer.from(value))) {
        await new Promise<void>((r) => ws.once("drain", r));
      }
      if (total > 0) onProgress(Math.min(0.99, written / total));
    }
    ws.end();
    await new Promise<void>((r, j) => {
      ws.on("error", j);
      ws.on("finish", r);
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ─── فحص ffprobe لكل مصدر ──────────────────────────────────────────
interface ProbeInfo {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

async function probeFile(file: string): Promise<ProbeInfo> {
  const ffprobe = await ffprobePath();
  const res = await run(ffprobe, [
    "-v", "error", "-print_format", "json",
    "-show_streams", "-show_format", file,
  ], { timeoutMs: 60_000 });
  if (res.code !== 0) throw new JobError(400, `ملف غير صالح أو غير مدعوم: ${path.basename(file)}`);
  let parsed: {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
    format?: { duration?: string };
  } = {};
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new JobError(400, `تعذر قراءة بيانات الملف: ${path.basename(file)}`);
  }
  const v = parsed.streams?.find((s) => s.codec_type === "video");
  const a = parsed.streams?.find((s) => s.codec_type === "audio");
  if (!v) throw new JobError(400, `لا يوجد مسار فيديو في: ${path.basename(file)}`);
  const duration = Number(v.duration || parsed.format?.duration || 0);
  return {
    width: v.width || 640,
    height: v.height || 360,
    duration: duration > 0 ? duration : 0,
    hasAudio: !!a,
  };
}

// تحديث مهمة + المهمة الموافقة في جدول tasks (بث التقدم الحي)
async function setJobProgress(jobId: string, progress: number, status?: JobRow["status"], error?: string | null): Promise<void> {
  await q(
    `UPDATE jobs SET progress = ?, status = COALESCE(?, status), error = COALESCE(?, error), updated_at = ? WHERE id = ?`,
    [Math.max(0, Math.min(100, Math.round(progress))), status ?? null, error ?? null, nowISO(), jobId],
  );
  await q(
    `UPDATE tasks SET progress = ?, status = CASE
       WHEN ? = 'done' THEN 'completed'
       WHEN ? = 'failed' THEN 'failed'
       ELSE 'processing' END,
       updated_at = ?
     WHERE provider_task_id = ? AND type = 'merge'`,
    [
      Math.max(0, Math.min(100, Math.round(progress))),
      status ?? "", status ?? "", nowISO(), jobId,
    ],
  );
  if (status === "done") {
    const origin = process.env.PUBLIC_APP_URL || "";
    const url = `${origin}/api/jobs/${jobId}/video`;
    await q(
      `UPDATE tasks SET result_urls_json = ?, status = 'completed', completed_at = COALESCE(completed_at, ?), progress = 100
       WHERE provider_task_id = ? AND type = 'merge'`,
      [JSON.stringify([url]), nowISO(), jobId],
    );
  }
  if (status === "failed") {
    await q(
      `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE provider_task_id = ? AND type = 'merge'`,
      [error ?? "فشل الدمج", nowISO(), jobId],
    );
  }
}

// ─── محرك الدمج — عملية متزامنة (~10–15 ثانية للمقاطع القصيرة) ─────
export async function processJob(jobId: string): Promise<{ ok: boolean; status?: string; error?: string; result?: Record<string, unknown> }> {
  if (processInFlight.has(jobId)) return { ok: true, status: "processing" };
  const job = await getJob(jobId);
  if (!job) return { ok: false, status: "not_found" };
  if (job.status === "done") return { ok: true, status: "done" };
  if (job.status === "failed") return { ok: false, status: "failed", error: job.error || "" };
  if (job.status === "uploading") return { ok: false, status: "uploading", error: "بانتظار اكتمال رفع الملفات" };

  processInFlight.add(jobId);
  const tmpFiles: string[] = [];
  const outPath = path.join(os.tmpdir(), `merge-${jobId}.mp4`);
  tmpFiles.push(outPath);
  try {
    await setJobProgress(jobId, 3, "processing");
    const rows = await listSourceRows(jobId);
    if (rows.length < 2) throw new JobError(400, "الدمج يحتاج مقطعَين على الأقل");
    if (rows.length > LIMITS.maxSources) throw new JobError(400, `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}`);

    // 1) تجميع المصادر إلى /tmp (تنزيل الروابط أو تجميع الأجزاء المرفوعة) — تقدم 0..40
    const srcPaths: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const dst = path.join(os.tmpdir(), `src-${jobId}-${i}.mp4`);
      tmpFiles.push(dst);
      if (r.kind === "url") {
        await downloadSource(r.url!, dst, (frac) =>
          setJobProgress(jobId, 3 + ((i + frac) / rows.length) * 37).catch(() => {}),
        );
      } else {
        const buf = await loadBlobChunks("source_chunks", { sql: "job_id = ? AND seq = ?", args: [jobId, r.seq] });
        if (!buf) throw new JobError(400, `المصدر ${i + 1} غير مرفوع بالكامل`);
        if (buf.length > LIMITS.sourceMaxMB * 1024 * 1024) throw new JobError(413, `حجم المصدر ${i + 1} يتجاوز الحد`);
        await fsp.writeFile(dst, buf);
      }
      srcPaths.push(dst);
      await setJobProgress(jobId, 3 + ((i + 1) / rows.length) * 37).catch(() => {});
    }

    // 2) فحص كل مصدر بـ ffprobe: الدقة، المدة، وجود صوت — والتحقق من حدود المدد
    const probes: ProbeInfo[] = [];
    for (const p of srcPaths) probes.push(await probeFile(p));
    const totalDuration = probes.reduce((s, p) => s + p.duration, 0);
    if (totalDuration > LIMITS.maxTotalDurationSec) {
      throw new JobError(400, `مجموع مدد المقاطع (${Math.round(totalDuration)} ثانية) يتجاوز الحد (${LIMITS.maxTotalDurationSec} ثانية)`);
    }

    // 3) توحيد المصادر: scale+pad إلى أكبر دقة (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، yuv420p
    const maxW = even(Math.min(1920, Math.max(...probes.map((p) => p.width))));
    const maxH = even(Math.min(1080, Math.max(...probes.map((p) => p.height))));
    const ffmpeg = await ffmpegPath();
    const preset = process.env.FFMPEG_PRESET || "medium";

    const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
    let silentIdx = rows.length;
    for (let i = 0; i < rows.length; i++) args.push("-i", srcPaths[i]);
    // مصدر بلا صوت؟ أضف مسارًا صامتًا بنفس مدته بدل أن يفشل الدمج
    const silentInputs: number[] = [];
    for (let i = 0; i < probes.length; i++) {
      if (!probes[i].hasAudio) {
        args.push("-f", "lavfi", "-t", String(Math.max(1, probes[i].duration || 1)), "-i", "anullsrc=r=44100:cl=stereo");
        silentInputs.push(silentIdx++);
      }
    }

    const chains: string[] = [];
    const concatLabels: string[] = [];
    for (let i = 0; i < probes.length; i++) {
      chains.push(
        `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`,
      );
      const audioSrc = probes[i].hasAudio ? `${i}:a` : `${silentInputs.shift()}:a`;
      chains.push(`[${audioSrc}]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      concatLabels.push(`[v${i}]`, `[a${i}]`);
    }
    const filter = `${chains.join(";")};${concatLabels.join("")}concat=n=${probes.length}:v=1:a=1[vout][aout]`;

    // 4) ترميز نهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart — MP4 عالي الجودة يعمل فورًا
    args.push(
      "-filter_complex", filter,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", preset, "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-progress", "pipe:1", "-nostats",
      "-f", "mp4", outPath,
    );

    const totalUs = Math.max(1, totalDuration) * 1_000_000;
    const enc = run(ffmpeg, args, { timeoutMs: 280_000, onStdoutLine: (line) => {
      const m = line.match(/out_time_us=(\d+)/);
      if (m) {
        const frac = Math.min(1, Number(m[1]) / totalUs);
        // 40..90 ترميز
        setJobProgress(jobId, 40 + frac * 50).catch(() => {});
      }
    } });
    const res = await enc;
    if (res.code !== 0 || !fs.existsSync(outPath)) {
      // فشل ترميز معلن من ffmpeg = فشل حتمي فوري — لا إعادة محاولة
      throw new JobError(500, `فشل ترميز الفيديو: ${(res.stderr || "خطأ غير معروف").slice(-300)}`);
    }

    // 5) تحقق من الناتج: الحجم والمدة والدقة
    const outSize = fs.statSync(outPath).size;
    if (outSize > LIMITS.outputMaxMB * 1024 * 1024) {
      throw new JobError(413, `حجم الناتج (${(outSize / 1024 / 1024).toFixed(1)}MB) يتجاوز الحد (${LIMITS.outputMaxMB}MB)`);
    }
    const outProbe = await probeFile(outPath);
    const resolution = `${outProbe.width}x${outProbe.height}`;

    // 6) حفظ الناتج كصفوف 2MB في Turso ثم حذف أجزاء المصادر (الناتج فقط هو المطلوب)
    await setJobProgress(jobId, 92, "processing");
    const buf = await fsp.readFile(outPath);
    await saveBlobChunks("output_chunks", { job_id: jobId }, buf);
    await q("DELETE FROM source_chunks WHERE job_id = ?", [jobId]);

    await q(
      `UPDATE jobs SET status = 'done', progress = 100, output_url = ?, output_size = ?, output_duration = ?, output_resolution = ?, error = NULL, updated_at = ? WHERE id = ?`,
      [`/api/jobs/${jobId}/video`, outSize, outProbe.duration, resolution, nowISO(), jobId],
    );
    await setJobProgress(jobId, 100, "done");
    return {
      ok: true,
      status: "done",
      result: { size: outSize, duration: outProbe.duration, resolution },
    };
  } catch (e) {
    const err = e instanceof JobError ? e : (e instanceof Error ? e : new Error(String(e)));
    const permanent = e instanceof JobError; // أخطاء الحدود/المصادر/الترميز = فشل حتمي فوري
    if (permanent) {
      await setJobProgress(jobId, 100, "failed", err.message).catch(() => {});
      return { ok: false, status: "failed", error: err.message };
    }
    // أخطاء شبكتنا/البيئة = مؤقتة → تبقى processing وتُعاد المحاولة عبر get_task
    await q("UPDATE jobs SET status = 'processing', updated_at = ? WHERE id = ?", [nowISO(), jobId]);
    return { ok: false, status: "processing", error: err.message };
  } finally {
    // تنظيف /tmp دائمًا — لا اعتماد على نظام ملفات دائم
    for (const f of tmpFiles) {
      await fsp.rm(f, { force: true }).catch(() => {});
    }
    processInFlight.delete(jobId);
  }
}

// ─── بث الناتج مع دعم Range (206) ──────────────────────────────────
// حوّل صفوف الـ Blobs إلى stream مع تقليم أول/آخر جزء حسب المدى المطلوب
export async function readOutputRange(
  jobId: string,
  start: number,
  end: number, // شامل
): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> {
  const rows = await (await import("./storage")).outputChunkRows(jobId);
  if (!rows.length) return null;
  const size = rows.reduce((s, r) => s + r.data.length, 0);
  if (start >= size) return null;
  const safeEnd = Math.min(end, size - 1);
  let offset = 0;
  const buffers = rows.map((r) => r.data);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      for (; buffers.length; ) {
        const buf = buffers.shift()!;
        const bufStart = offset;
        const bufEnd = offset + buf.length - 1;
        offset = bufEnd + 1;
        if (bufEnd < start || bufStart > safeEnd) continue;
        const s = Math.max(0, start - bufStart);
        const e = Math.min(buf.length - 1, safeEnd - bufStart);
        controller.enqueue(new Uint8Array(buf.subarray(s, e + 1)));
        return;
      }
      controller.close();
    },
  });
  return { stream, size };
}
