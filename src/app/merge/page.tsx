"use client";

// صفحة دمج الفيديوهات — واجهة كاملة عربية RTL (رفع روابط/ملفات، ترتيب، دمج بمعالجة حية، نتيجة، توثيق API)
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, Plus, Trash2, ChevronUp, ChevronDown, Play, Download, Copy, Check,
  RotateCcw, Timer, FileVideo, Link2, GripVertical, ChevronDown as ChevronDownDoc, Loader2,
} from "lucide-react";

interface Source {
  kind: "url" | "file";
  url?: string;
  file?: File;
  name: string;
}
interface JobStatus {
  jobId: string;
  status: string;
  progress?: number;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
  expiresAt?: string;
}

const ACCEPTED = ["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "3gp"];
const UPLOAD_CHUNK = 4 * 1024 * 1024; // حد حجم الطلب في Vercel ≈ 4.5MB → أجزاء 4MB مع إعادة محاولة ×3

function fmtSize(n?: number | null): string {
  if (!n && n !== 0) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDur(n?: number | null): string {
  if (!n && n !== 0) return "—";
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => { try { await navigator.clipboard.writeText(text); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700/60"
    >
      {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
      {copied ? "تم النسخ" : "نسخ الرابط"}
    </button>
  );
}

export default function MergePage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [phase, setPhase] = useState<"idle" | "uploading" | "processing" | "done" | "failed">("idle");
  const [uploadPct, setUploadPct] = useState(0);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [remaining, setRemaining] = useState<string>("—");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragIdx = useRef<number | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    // استئناف العرض بعد تحديث الصفحة عبر #job=<id>
    const m = window.location.hash.match(/job=([\w-]+)/);
    if (m) resumeJob(m[1]);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // عدّاد تنازلي حتى انتهاء الصلاحية (24 ساعة)
  useEffect(() => {
    if (!job?.expiresAt) return;
    const t = setInterval(() => {
      const ms = new Date(job.expiresAt!).getTime() - Date.now();
      if (ms <= 0) return setRemaining("انتهت الصلاحية");
      const h = Math.floor(ms / 3600000);
      const mn = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setRemaining(`${h} ساعة ${mn} دقيقة ${s} ثانية`);
    }, 1000);
    return () => clearInterval(t);
  }, [job?.expiresAt]);

  function addUrl() {
    const u = urlInput.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) { setError("أدخل رابط فيديو مباشر صالح (http/https)"); return; }
    setError(null);
    setSources((s) => [...s, { kind: "url", url: u, name: u.split("/").pop() || u }]);
    setUrlInput("");
  }

  function addFiles(files: FileList | File[]) {
    const bad: string[] = [];
    for (const f of Array.from(files)) {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      if (!ACCEPTED.includes(ext)) { bad.push(f.name); continue; }
      setSources((s) => [...s, { kind: "file", file: f, name: f.name }]);
    }
    if (bad.length) setError(`صيغ غير مدعومة: ${bad.join("، ")} — المسموح: ${ACCEPTED.join("/ ")}`);
    else setError(null);
  }

  function move(i: number, dir: -1 | 1) {
    setSources((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const c = [...s];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  }
  function remove(i: number) {
    setSources((s) => s.filter((_, k) => k !== i));
  }
  function onDropReorder(target: number) {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === target) return;
    setSources((s) => {
      const c = [...s];
      const [it] = c.splice(from, 1);
      c.splice(target, 0, it);
      return c;
    });
  }

  // رفع ملف واحد بأجزاء 4MB مع إعادة محاولة ×3
  async function uploadFile(jobId: string, seq: number, file: File) {
    const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK));
    for (let k = 0; k < total; k++) {
      const chunk = file.slice(k * UPLOAD_CHUNK, (k + 1) * UPLOAD_CHUNK);
      const isLast = k === total - 1;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const r = await fetch(`/api/upload?job=${jobId}&seq=${seq}&chunk=${k}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", ...(isLast ? { "x-final": "1" } : {}) },
            body: chunk,
          });
          ok = r.ok;
        } catch { ok = false; }
        if (!ok && attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
      if (!ok) throw new Error(`فشل رفع الجزء ${k + 1}/${total} من ${file.name} بعد 3 محاولات`);
      setUploadPct(Math.round(((k + 1) / total) * 100));
    }
  }

  async function pollStatus(jobId: string): Promise<JobStatus> {
    const r = await fetch(`/api/jobs/${jobId}`);
    const j = (await r.json()) as JobStatus & { error?: string };
    if (!r.ok && j.error) throw new Error(j.error);
    return j;
  }

  function startPolling(jobId: string, intervalMs = 1500) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const st = await pollStatus(jobId);
        setJob(st);
        if (st.status === "done") { clearInterval(pollRef.current!); setPhase("done"); }
        if (st.status === "failed") { clearInterval(pollRef.current!); setPhase("failed"); setError(st.error || "فشل الدمج"); }
      } catch { /* استمر بالاستعلام */ }
    }, intervalMs);
  }

  async function resumeJob(jobId: string) {
    try {
      const st = await pollStatus(jobId);
      setJob(st);
      if (st.status === "done") { setPhase("done"); return; }
      if (st.status === "failed") { setPhase("failed"); setError(st.error || "فشل الدمج"); return; }
      if (st.status === "queued") {
        setPhase("processing");
        startPolling(jobId);
        // نفّذ process إن لم يُنفَّذ بعد
        fetch(`/api/jobs/${jobId}/process`, { method: "POST" }).catch(() => {});
        return;
      }
      setPhase("processing");
      startPolling(jobId);
    } catch (e) {
      setPhase("failed");
      setError(e instanceof Error ? e.message : "تعذر استئناف المهمة");
    }
  }

  async function doMerge() {
    if (sources.length < 2) { setError("أضف مقطعَين على الأقل لبدء الدمج"); return; }
    if (sources.length > 10) { setError("أقصى عدد مقاطع للدمج هو 10"); return; }
    setError(null);
    try {
      setPhase("uploading");
      setUploadPct(0);
      // 1) إنشاء مهمة
      const body = {
        sources: sources.map((s) =>
          s.kind === "url"
            ? { kind: "url", url: s.url }
            : { kind: "file", name: s.name, size: s.file?.size, mime: s.file?.type || "video/mp4" },
        ),
      };
      const cr = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const cj = await cr.json();
      if (!cr.ok) throw new Error(cj.error || "فشل إنشاء مهمة الدمج");
      const jobId: string = cj.jobId;
      // 2) رفع أجزاء الملفات (إن وجدت)
      const fileSeqs = sources.map((s, i) => ({ s, i })).filter((x) => x.s.kind === "file");
      for (const { s, i } of fileSeqs) {
        await uploadFile(jobId, i, s.file!);
      }
      // 3) تنفيذ الدمج (متزامن ~10-15 ثانية) مع استطلاع الحالة بالتوازي
      setPhase("processing");
      setJob({ jobId, status: "processing", progress: 0 });
      startPolling(jobId);
      const pr = await fetch(`/api/jobs/${jobId}/process`, { method: "POST" });
      const pj = await pr.json();
      if (pr.status === 500) throw new Error(pj.error || "فشل الدمج");
      // 4) النتيجة النهائية
      const st = await pollStatus(jobId);
      setJob(st);
      if (pollRef.current) clearInterval(pollRef.current);
      if (st.status === "done") setPhase("done");
      else if (st.status === "failed") { setPhase("failed"); setError(st.error || "فشل الدمج"); }
      else { setPhase("processing"); startPolling(jobId, 2000); } // استمر بالاستطلاع حتى الاكتمال
    } catch (e) {
      setPhase("failed");
      setError(e instanceof Error ? e.message : "خطأ غير متوقع");
    }
  }

  function reset() {
    if (pollRef.current) clearInterval(pollRef.current);
    setPhase("idle");
    setJob(null);
    setError(null);
    setUploadPct(0);
    setSources([]);
    history.replaceState(null, "", "/merge");
  }

  const busy = phase === "uploading" || phase === "processing";

  const curlDocs = [
    ["إنشاء مهمة من روابط", `curl -X POST ${origin}/api/jobs \\\n  -H 'Content-Type: application/json' \\\n  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'`],
    ["تنفيذ الدمج", `curl -X POST ${origin}/api/jobs/<jobId>/process`],
    ["الحالة والتقدم", `curl ${origin}/api/jobs/<jobId>`],
    ["تحميل الناتج", `curl -O ${origin}/api/jobs/<jobId>/video?download=1`],
    ["بث الناتج (Range)", `curl -H 'Range: bytes=0-1023' ${origin}/api/jobs/<jobId>/video`],
    ["الحذف الفوري", `curl -X DELETE ${origin}/api/jobs/<jobId>`],
    ["الحدود العامة", `curl ${origin}/api/config`],
    ["رفع ملف بأجزاء 4MB", `curl -X POST "${origin}/api/upload?job=<jobId>&seq=0&chunk=0" \\\n  -H 'Content-Type: application/octet-stream' --data-binary @part0`],
  ];

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 bg-gradient-to-l from-cyan-400 to-fuchsia-400 bg-clip-text text-2xl font-extrabold text-transparent">
            <FileVideo className="h-6 w-6 text-cyan-400" /> دمج الفيديوهات
          </h1>
          <p className="mt-1 text-sm text-slate-400">ارفع مقاطعك أو أضف روابط مباشرة، رتّبها، واحصل على فيديو واحد عالي الجودة (MP4 — H.264 + AAC)</p>
        </div>
        <Link href="/" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm hover:bg-slate-800/60">
          <ArrowRight className="h-4 w-4" /> لوحة الإدارة
        </Link>
      </header>

      {phase === "done" && job?.status === "done" ? (
        /* ─── صفحة النتيجة ─── */
        <section className="rounded-2xl border border-emerald-500/30 bg-slate-900/60 p-6 shadow-xl">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-emerald-300">✅ اكتمل الدمج بنجاح</h2>
          <video src={job.videoUrl} controls className="mb-4 w-full rounded-xl border border-slate-700 bg-black" />
          <div className="mb-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            <div className="rounded-xl border border-slate-700 bg-slate-800/40 px-3 py-2.5">
              <p className="text-sm font-bold text-slate-200">{fmtSize(job.size)}</p>
              <p className="text-xs text-slate-400">الحجم</p>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-800/40 px-3 py-2.5">
              <p className="text-sm font-bold text-slate-200">{fmtDur(job.duration)}</p>
              <p className="text-xs text-slate-400">المدة</p>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-800/40 px-3 py-2.5">
              <p className="text-sm font-bold text-slate-200" dir="ltr">{job.resolution || "—"}</p>
              <p className="text-xs text-slate-400">الدقة</p>
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
              <p className="flex items-center justify-center gap-1 text-sm font-bold text-amber-300"><Timer className="h-4 w-4" /> {remaining}</p>
              <p className="text-xs text-amber-200/70">الوقت المتبقي قبل الحذف</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <a href={job.downloadUrl || job.videoUrl} className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-l from-cyan-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90">
              <Download className="h-4 w-4" /> تحميل
            </a>
            <CopyBtn text={job.videoUrl || ""} />
            <button onClick={reset} className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm hover:bg-slate-700/60">
              <RotateCcw className="h-4 w-4" /> عملية جديدة
            </button>
          </div>
          <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            ⚠️ ملف الدمج يُحذف تلقائيًا بعد 24 ساعة — شاهده/نزّله سريعًا.
          </p>
        </section>
      ) : (
        <>
          {/* ─── إضافة الروابط ─── */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl">
            <h2 className="mb-3 flex items-center gap-2 text-lg font-bold"><Link2 className="h-5 w-5 text-cyan-400" /> 1) أضف الروابط أو ارفع الملفات</h2>
            <div className="flex gap-2">
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addUrl())}
                placeholder="https://example.com/clip.mp4"
                dir="ltr"
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2.5 text-sm outline-none focus:border-cyan-500"
                disabled={busy}
              />
              <button onClick={addUrl} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-4 py-2.5 text-sm text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40">
                <Plus className="h-4 w-4" /> إضافة
              </button>
            </div>

            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) addFiles(e.dataTransfer.files); }}
              className={`mt-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${dragOver ? "border-cyan-400 bg-cyan-500/10" : "border-slate-700 bg-slate-800/30"}`}
            >
              <FileVideo className="mb-2 h-8 w-8 text-slate-400" />
              <p className="text-sm text-slate-300">اسحب ملفات الفيديو وأفلِتها هنا</p>
              <p className="mt-1 text-xs text-slate-500">{ACCEPTED.join(" / ")} — حتى 200MB لكل ملف</p>
              <label className="mt-3 cursor-pointer rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700/60">
                اختر ملفات من الجهاز
                <input type="file" multiple accept={ACCEPTED.map((e) => `.${e}`).join(",")} className="hidden" onChange={(e) => e.target.files && addFiles(e.target.files)} disabled={busy} />
              </label>
            </div>

            {/* ─── قائمة المصادر القابلة لإعادة الترتيب ─── */}
            {sources.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-xs text-slate-400">ترتيب القائمة = ترتيب الدمج — اسحب لإعادة الترتيب أو استخدم الأسهم:</p>
                <ul className="space-y-2">
                  {sources.map((s, i) => (
                    <li
                      key={`${i}-${s.name}`}
                      draggable={!busy}
                      onDragStart={() => (dragIdx.current = i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDropReorder(i)}
                      className="flex items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-800/40 px-3 py-2.5"
                    >
                      <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-500" />
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 text-xs font-bold text-cyan-300">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-sm" dir={s.kind === "url" ? "ltr" : undefined} title={s.name}>
                        {s.kind === "file" ? <FileVideo className="me-1.5 inline h-4 w-4 text-violet-400" /> : null}
                        {s.name}
                        {s.kind === "file" && s.file ? <span className="ms-2 text-xs text-slate-500">({fmtSize(s.file.size)})</span> : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button onClick={() => move(i, -1)} disabled={i === 0 || busy} aria-label="أعلى" className="rounded-md border border-slate-600 p-1 hover:bg-slate-700/60 disabled:opacity-30"><ChevronUp className="h-3.5 w-3.5" /></button>
                        <button onClick={() => move(i, 1)} disabled={i === sources.length - 1 || busy} aria-label="أسفل" className="rounded-md border border-slate-600 p-1 hover:bg-slate-700/60 disabled:opacity-30"><ChevronDown className="h-3.5 w-3.5" /></button>
                        <button onClick={() => remove(i)} disabled={busy} aria-label="حذف" className="rounded-md border border-rose-500/40 bg-rose-500/10 p-1 text-rose-300 hover:bg-rose-500/20 disabled:opacity-30"><Trash2 className="h-3.5 w-3.5" /></button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {error && <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}

            {/* ─── زر الدمج + التقدم ─── */}
            <button
              onClick={doMerge}
              disabled={busy || sources.length < 2}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-l from-cyan-600 to-fuchsia-600 px-4 py-3 text-base font-bold text-white hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />}
              {phase === "uploading" ? `جارٍ رفع الملفات… ${uploadPct}%` : phase === "processing" ? `جارٍ الدمج… ${job?.progress ?? 0}%` : "دمج الفيديوهات"}
            </button>
            {busy && (
              <div className="mt-3">
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-fuchsia-500 transition-all"
                    style={{ width: `${phase === "uploading" ? uploadPct : job?.progress ?? 0}%` }}
                  />
                </div>
                <p className="mt-1.5 text-center text-xs text-slate-400">
                  {phase === "uploading" ? "رفع أجزاء الملفات (4MB لكل جزء مع إعادة محاولة تلقائية)" : "سحب المصادر ← توحيد الدقة ← ترميز H.264/AAC ← الحفظ"}
                </p>
              </div>
            )}
            {phase === "failed" && (
              <button onClick={reset} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm hover:bg-slate-700/60">
                <RotateCcw className="h-4 w-4" /> بدء من جديد
              </button>
            )}
          </section>

          {/* ─── الحدود ─── */}
          <p className="mt-3 text-center text-xs text-slate-500">
            الحدود: 10 مقاطع كحد أقصى • 200MB لكل مصدر • 150MB للناتج • 600 ثانية مجموع المدد • الناتج يُحذف بعد 24 ساعة
          </p>
        </>
      )}

      {/* ─── توثيق API قابل للطي ─── */}
      <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl">
        <button onClick={() => setDocsOpen(!docsOpen)} className="flex w-full items-center justify-between text-lg font-bold">
          <span>توثيق API للمطورين</span>
          <ChevronDownDoc className={`h-5 w-5 transition-transform ${docsOpen ? "rotate-180" : ""}`} />
        </button>
        {docsOpen && (
          <div className="mt-4 space-y-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-xs text-slate-400">
                  <th className="py-2 text-start">Method</th>
                  <th className="py-2 text-start">Endpoint</th>
                  <th className="py-2 text-start">الوظيفة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {[
                  ["POST", "/api/jobs", "إنشاء مهمة دمج"],
                  ["POST", "/api/upload?job=<id>&seq=<n>&chunk=<k>", "رفع أجزاء الملفات (ثنائي ≤4MB)"],
                  ["POST", "/api/jobs/<id>/process", "تنفيذ الدمج كاملًا → رابط الفيديو النهائي"],
                  ["GET", "/api/jobs/<id>", "الحالة + التقدم (0–100) + الرابط عند الاكتمال"],
                  ["GET", "/api/jobs/<id>/video", "بث الناتج بدعم Range، و?download=1 للتحميل"],
                  ["DELETE", "/api/jobs/<id>", "حذف فوري شامل"],
                  ["GET", "/api/config", "الحدود العامة + version"],
                  ["GET", "/api/cron", "حذف المهام المنتهية (Cron يومي)"],
                ].map(([m, e, d]) => (
                  <tr key={`${m}-${e}`}>
                    <td className="py-2 font-mono text-xs text-cyan-300" dir="ltr">{m}</td>
                    <td className="py-2 font-mono text-xs text-slate-300" dir="ltr">{e}</td>
                    <td className="py-2 text-xs text-slate-400">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="space-y-3">
              {curlDocs.map(([title, cmd]) => (
                <div key={title}>
                  <p className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-300">
                    {title}
                    <CopyBtn text={cmd} />
                  </p>
                  <pre dir="ltr" className="overflow-auto rounded-lg border border-slate-700/70 bg-slate-950/70 p-3 text-left text-xs text-slate-300">{cmd}</pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <footer className="mt-8 pb-6 text-center text-xs text-slate-600">
        دمج عالي الجودة: توحيد الدقة (حد أقصى 1920×1080) • fps 30 • libx264 CRF 18 + AAC 192k • +faststart للتشغيل الفوري على الويب
      </footer>
    </main>
  );
}
