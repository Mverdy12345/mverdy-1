// عميل خدمة الدمج للمنسّق — وضعان:
//  1) مدمج (الافتراضي): لا MERGER_API_BASE → استدعاء منطق الخدمة داخل نفس العملية (أنسب للـ serverless)
//  2) خارجي: MERGER_API_BASE مضبوط → HTTP وفق أشكال Video Merger API v2 المقاسة (spec §7)
import { after } from "next/server";
import {
  createJob, getJob, processJob, isProcessInFlight, deleteJob, cleanupExpired,
  type SourceSpec, type JobRow,
} from "./service";

export interface MergerStatusResult {
  status: "queued" | "uploading" | "processing" | "done" | "failed" | "not_found";
  progress?: number;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
  expiresAt?: string;
}

const externalBase = () => (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
export const isExternalMerger = () => externalBase().length > 0 && externalBase() !== "self";

// قفل "أُطلق process مرة واحدة" للوضع الخارجي — يمنع التزامن مع get_task
const g = globalThis as unknown as { __mergeKicked?: Set<string> };
if (!g.__mergeKicked) g.__mergeKicked = new Set<string>();
const kicked = g.__mergeKicked;

/** إطلاق المعالجة خلفيًا وبمرة واحدة فقط — مع إبقاء الـ invocation حيًا على Vercel عبر after() */
export function kickProcess(jobId: string): void {
  if (isExternalMerger()) {
    if (kicked.has(jobId)) return;
    kicked.add(jobId);
    const p = fetch(`${externalBase()}/api/jobs/${jobId}/process`, { method: "POST" })
      .catch(() => {}) // الشبكة تُعاد محاولتها عبر get_task
      .then(() => undefined);
    try {
      after(p);
    } catch {
      /* خارج نطاق الطلب */
    }
    return;
  }
  // مدمج: نشغّل فورًا (وعد عائم) ونسجّله في after() ليستمر حتى بعد إغلاق الاستجابة
  if (isProcessInFlight(jobId)) return;
  const p = processJob(jobId)
    .catch(() => undefined)
    .then(() => undefined);
  try {
    after(p);
  } catch {
    /* خارج نطاق الطلب */
  }
}

export async function createMergeJob(sources: SourceSpec[]): Promise<{ jobId: string; status: string; statusUrl?: string; processUrl?: string; expiresAt?: string }> {
  await cleanupExpired(); // تنظيف كسول عند كل إنشاء/دمج
  if (isExternalMerger()) {
    const res = await fetch(`${externalBase()}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: sources.map((s) => (s.kind === "url" ? s.url : null)).filter(Boolean) }),
    });
    const json = (await res.json().catch(() => null)) as { jobId?: string; status?: string; statusUrl?: string; processUrl?: string; expiresAt?: string; error?: string } | null;
    const jobId = json?.jobId;
    if (!res.ok || !jobId) throw new Error(json?.error || `فشل إنشاء مهمة الدمج (HTTP ${res.status})`);
    return { jobId, status: json?.status || "queued", statusUrl: json?.statusUrl, processUrl: json?.processUrl, expiresAt: json?.expiresAt };
  }
  const job = await createJob(sources);
  return { jobId: job.id, status: job.status, expiresAt: job.expires_at || undefined };
}

/** تحليل حالة دفاعي (spec §7.2) — كلمات الحالة، progress كسرًا 0..1، وأولوية videoUrl ثم downloadUrl */
function parseStatusRow(obj: Record<string, unknown>, origin: string): MergerStatusResult {
  const raw = String(obj.status ?? obj.state ?? "").toLowerCase();
  const doneWords = ["done", "completed", "complete", "success", "succeeded", "finished"];
  const failWords = ["error", "failed", "failure", "cancelled", "canceled"];
  let status: MergerStatusResult["status"] = "processing";
  if (doneWords.includes(raw)) status = "done";
  else if (failWords.includes(raw)) status = "failed";
  else if (raw === "queued" || raw === "uploading") status = raw as MergerStatusResult["status"];

  // الجسم قد يرد فيه error بدون حقل status → عاملها failed فورًا
  const err = obj.error ? String(obj.error) : undefined;
  if (err && !raw) status = "failed";

  let progress = Number(obj.progress ?? 0);
  if (progress > 0 && progress <= 1) progress *= 100; // يأتي أحيانًا كسرًا

  const base = isExternalMerger() ? externalBase() : origin.replace(/\/+$/, "");
  const videoUrl =
    (typeof obj.videoUrl === "string" && obj.videoUrl) ||
    (typeof obj.downloadUrl === "string" && obj.downloadUrl) ||
    (obj.jobId || obj.id ? `${base}/api/jobs/${obj.jobId || obj.id}/video` : undefined);

  return {
    status,
    progress: Math.round(progress),
    videoUrl: status === "done" ? videoUrl : undefined,
    downloadUrl: status === "done" && typeof obj.downloadUrl === "string" ? obj.downloadUrl : videoUrl,
    size: typeof obj.size === "number" ? obj.size : undefined,
    duration: typeof obj.duration === "number" ? obj.duration : undefined,
    resolution: typeof obj.resolution === "string" ? obj.resolution : undefined,
    error: err,
    expiresAt: typeof obj.expiresAt === "string" ? obj.expiresAt : undefined,
  };
}

function rowToStatus(job: JobRow, origin: string): MergerStatusResult {
  const base = origin.replace(/\/+$/, "");
  const videoUrl = `${base}/api/jobs/${job.id}/video`;
  return {
    status: job.status === "done" ? "done" : job.status === "failed" ? "failed" : job.status,
    progress: job.progress,
    videoUrl: job.status === "done" ? videoUrl : undefined,
    downloadUrl: job.status === "done" ? `${videoUrl}?download=1` : undefined,
    size: job.output_size ?? undefined,
    duration: job.output_duration ?? undefined,
    resolution: job.output_resolution ?? undefined,
    error: job.error ?? undefined,
    expiresAt: job.expires_at ?? undefined,
  };
}

export async function getMergeStatus(jobId: string, origin = ""): Promise<MergerStatusResult> {
  if (isExternalMerger()) {
    const res = await fetch(`${externalBase()}/api/jobs/${jobId}`, { method: "GET" }).catch(() => null);
    if (!res) return { status: "processing", error: "تعذر الاتصال بخدمة الدمج — سيُعاد الاستعلام تلقائيًا" };
    if (res.status === 404) {
      // 404 → فشل نهائي: المهمة حُذفت أو انتهت صلاحيتها بعد 24 ساعة
      return { status: "failed", error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return { status: "processing", error: "استجابة غير مفهومة من خدمة الدمج" };
    return parseStatusRow({ ...json, jobId }, origin);
  }
  const job = await getJob(jobId);
  if (!job) return { status: "failed", error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  return rowToStatus(job, origin);
}

/** إن كانت قيد المعالجة ولم يُنفَّذ process بعد فنفّذه الآن (مع قفل الذاكرة) */
export async function ensureProcessRunning(jobId: string): Promise<void> {
  if (isExternalMerger()) {
    if (!kicked.has(jobId)) kickProcess(jobId);
    return;
  }
  const job = await getJob(jobId);
  if (!job) return;
  if (["queued", "processing"].includes(job.status) && !isProcessInFlight(jobId)) kickProcess(jobId);
}

export async function removeMergeJob(jobId: string): Promise<void> {
  if (isExternalMerger()) {
    await fetch(`${externalBase()}/api/jobs/${jobId}`, { method: "DELETE" }).catch(() => {});
    return;
  }
  await deleteJob(jobId);
}

/** فحص جهوزية خدمة الدمج (مهلة 4 ثوانٍ) */
export async function mergerHealthy(): Promise<{ base: string; healthy: boolean; error?: string }> {
  if (isExternalMerger()) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${externalBase()}/api/config`, { signal: controller.signal });
      clearTimeout(t);
      return { base: externalBase(), healthy: res.ok };
    } catch (e) {
      return { base: externalBase(), healthy: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  // مدمج: فحص وجود ffmpeg داخل العملية
  try {
    const { ffmpegPath } = await import("./bin");
    await ffmpegPath();
    return { base: "(مدمجة في التطبيق)", healthy: true };
  } catch (e) {
    return { base: "(مدمجة في التطبيق)", healthy: false, error: e instanceof Error ? e.message : String(e) };
  }
}
