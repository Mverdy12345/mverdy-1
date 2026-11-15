"use client";

// لوحة الإدارة العربية RTL — ثلاث بطاقات: مدير المفاتيح، لوحة المهام، ربط السيرفر
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  KeyRound, Trash2, PowerOff, Power, Copy, Check, Activity, Images, Video, Merge,
  RefreshCw, Plus, ExternalLink, AlertTriangle, Database, Cable, Clock, Layers,
} from "lucide-react";

interface KeyItem {
  id: string; provider: string; label: string; masked: string; status: string;
  usageCount: number; successCount: number; failCount: number; lastUsedAt?: string | null; lastError?: string | null; createdAt: string;
}
interface TaskItem {
  id: string; type: string; model: string; status: string; progress: number; prompt: string;
  urls: string[]; error?: string | null; attempts: number; provider?: string | null; createdAt: string;
}
interface Health {
  ok: boolean; database: string; mcpEndpoint: string; authRequired: boolean;
  merger: { base: string; healthy: boolean; mode?: string };
  models: { canonical: string; type: string; providers: string[] }[];
}

const statusStyle: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  exhausted: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  disabled: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};
const statusAr: Record<string, string> = { active: "نشط", exhausted: "مستنزف", disabled: "معطّل" };
const taskStatusAr: Record<string, string> = { completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "بانتظار" };
const taskStatusStyle: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  processing: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  pending: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};
const typeAr: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

function timeAgo(iso: string): string {
  const d = new Date(iso.endsWith("Z") || iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return `قبل ${s} ثانية`;
  if (s < 3600) return `قبل ${Math.floor(s / 60)} دقيقة`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} ساعة`;
  return `قبل ${Math.floor(s / 86400)} يوم`;
}

function CopyBtn({ text, small }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch { /* fallback */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={small
        ? "inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs hover:bg-slate-700/60 transition-colors"
        : "inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2 text-sm hover:bg-slate-700/60 transition-colors"}
      aria-label="نسخ"
    >
      {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
      {copied ? "تم النسخ" : "نسخ"}
    </button>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      setKeys(j.keys || []);
    } catch { /* تجاهل */ }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const j = await r.json();
      setTasks(j.tasks || []);
      setStats(j.stats || { total: 0, completed: 0, failed: 0, processing: 0 });
    } catch { /* تجاهل */ }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    loadKeys();
    loadTasks();
    // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    pollRef.current = setInterval(loadTasks, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadKeys, loadTasks]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setAddMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const j = await r.json();
      if (!r.ok) setAddMsg({ ok: false, text: j.error || "فشل إضافة المفتاح" });
      else {
        setAddMsg({ ok: true, text: "تمت إضافة المفتاح — سيدخل في نهاية طابور التجربة التسلسلية" });
        setApiKey("");
        setLabel("");
        loadKeys();
      }
    } catch {
      setAddMsg({ ok: false, text: "تعذر الاتصال بالخادم" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: k.status === "disabled" ? "active" : "disabled" }),
    });
    loadKeys();
  }
  async function deleteKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    loadKeys();
  }

  const mcpUrl = `${origin}/mcp`;
  const authHeaders = health?.authRequired ? `,\n        "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }` : "";
  const configs = {
    chatgpt: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${authHeaders}
    }
  }
}`,
    claude: `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl}"${authHeaders}
    }
  }
}`,
    cursor: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${authHeaders}
    }
  }
}`,
  };
  const toolChips = [
    { icon: Images, name: "generate_image", desc: "توليد صورة من وصف نصي ويعيد الرابط جاهزًا" },
    { icon: Video, name: "generate_video", desc: "توليد فيديو بصوت متزامن (يتابع بـ get_task)" },
    { icon: Merge, name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب" },
    { icon: Activity, name: "get_task", desc: "تتبع أي مهمة ومعرفتها حتى الاكتمال" },
    { icon: Layers, name: "list_media", desc: "استرجاع الوسائط المخزنة سابقًا بروابطها" },
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      {/* الهيدر: حالة الخدمة */}
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="bg-gradient-to-l from-cyan-400 via-violet-400 to-fuchsia-400 bg-clip-text text-3xl font-extrabold text-transparent">
            M-Verdy — مولّد الوسائط MCP
          </h1>
          <p className="mt-1 text-sm text-slate-400">خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مفاتيح متسلسلة مع تبديل تلقائي فوري</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${health?.database === "turso-connected" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300"}`}>
            <Database className="h-4 w-4" />
            {health?.database === "turso-connected" ? "Turso متصل" : "Turso غير متصل"}
          </span>
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${health?.merger?.healthy ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>
            <Merge className="h-4 w-4" />
            خدمة الدمج {health?.merger?.healthy ? "جاهزة" : "غير جاهزة"}
          </span>
          <Link href="/merge" className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-cyan-300 hover:bg-cyan-500/20 transition-colors">
            <Merge className="h-4 w-4" /> صفحة دمج الفيديوهات
          </Link>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* (أ) مدير المفاتيح */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl lg:col-span-1" aria-label="مدير المفاتيح">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-bold">
            <KeyRound className="h-5 w-5 text-cyan-400" /> مدير المفاتيح
          </h2>
          <form onSubmit={addKey} className="mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-slate-400">المزود</span>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                  aria-label="اختيار المزود"
                >
                  <option value="kie">kie.ai</option>
                  <option value="cometapi">CometAPI</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-slate-400">تسمية (اختياري)</span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="مثال: حساب رئيسي"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">مفتاح API</span>
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="الصق المفتاح هنا…"
                required
                className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm outline-none focus:border-cyan-500"
                dir="ltr"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !apiKey.trim()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-l from-cyan-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <Plus className="h-4 w-4" /> {busy ? "جارٍ الإضافة…" : "إضافة المفتاح"}
            </button>
            {addMsg && (
              <p className={`rounded-lg border px-3 py-2 text-xs ${addMsg.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300"}`}>
                {addMsg.text}
              </p>
            )}
          </form>

          <p className="mb-3 rounded-lg border border-slate-700/60 bg-slate-800/40 px-3 py-2 text-xs leading-relaxed text-slate-400">
            أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
          </p>

          <div className="max-h-96 space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]">
            {keys.length === 0 && <p className="text-sm text-slate-500">لا توجد مفاتيح بعد — أضف أول مفتاح لبدء التوليد.</p>}
            {keys.map((k) => (
              <div key={k.id} className="rounded-xl border border-slate-700/70 bg-slate-800/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" dir="ltr">{k.masked}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {k.provider === "kie" ? "kie.ai" : "CometAPI"} {k.label ? `• ${k.label}` : ""}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${statusStyle[k.status] || ""}`}>
                    {statusAr[k.status] || k.status}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                  <span>استخدام: {k.usageCount}</span>
                  <span className="text-emerald-400">نجاح: {k.successCount}</span>
                  <span className="text-rose-400">فشل: {k.failCount}</span>
                  {k.lastUsedAt && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{timeAgo(k.lastUsedAt)}</span>}
                </div>
                {k.lastError && <p className="mt-1 truncate text-xs text-rose-400/80" title={k.lastError}>آخر خطأ: {k.lastError}</p>}
                <div className="mt-2 flex gap-2">
                  <button onClick={() => toggleKey(k)} className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs hover:bg-slate-700/60">
                    {k.status === "disabled" ? <><Power className="h-3.5 w-3.5 text-emerald-400" /> تنشيط</> : <><PowerOff className="h-3.5 w-3.5 text-amber-400" /> تعطيل</>}
                  </button>
                  <button onClick={() => deleteKey(k)} className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/20">
                    <Trash2 className="h-3.5 w-3.5" /> حذف
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* (ب) لوحة المهام */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl lg:col-span-2" aria-label="لوحة المهام">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Activity className="h-5 w-5 text-violet-400" /> لوحة المهام
            </h2>
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500"><RefreshCw className="h-3.5 w-3.5 animate-spin [animation-duration:3s]" /> تحديث تلقائي كل 5 ثوانٍ</span>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "الإجمالي", value: stats.total, cls: "text-slate-200" },
              { label: "مكتملة", value: stats.completed, cls: "text-emerald-300" },
              { label: "فاشلة", value: stats.failed, cls: "text-rose-300" },
              { label: "جارية", value: stats.processing, cls: "text-sky-300" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-slate-700/70 bg-slate-800/40 px-3 py-2.5 text-center">
                <p className={`text-2xl font-extrabold ${s.cls}`}>{s.value}</p>
                <p className="text-xs text-slate-400">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]">
            {tasks.length === 0 && <p className="text-sm text-slate-500">لا توجد مهام بعد — استدعِ generate_image أو generate_video من عميل MCP.</p>}
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl border border-slate-700/70 bg-slate-800/40 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-slate-600 bg-slate-800/70 px-2 py-0.5 text-xs">
                    {t.type === "image" ? "🖼️" : t.type === "merge" ? "🔗" : "🎬"} {typeAr[t.type] || t.type}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${taskStatusStyle[t.status] || ""}`}>{taskStatusAr[t.status] || t.status}</span>
                  <span className="text-xs text-slate-500" dir="ltr">{t.model}</span>
                  <span className="ms-auto text-xs text-slate-500">{timeAgo(t.createdAt)}</span>
                </div>
                {t.prompt && <p className="mt-2 line-clamp-2 text-sm text-slate-300">{t.prompt}</p>}
                {t.status === "processing" && (
                  <div className="mt-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
                      <div className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-violet-500 transition-all" style={{ width: `${t.progress}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{t.progress}%</p>
                  </div>
                )}
                {t.status === "failed" && t.error && <p className="mt-2 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5 text-xs text-rose-300">❌ {t.error}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">محاولات: {t.attempts}</span>
                  {t.urls.map((u) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20">
                      <ExternalLink className="h-3 w-3" /> فتح النتيجة
                    </a>
                  ))}
                  {t.urls.map((u) => (
                    <CopyBtn key={`c-${u}`} text={u} small />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* (ج) ربط السيرفر */}
      <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl" aria-label="ربط السيرفر">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold">
          <Cable className="h-5 w-5 text-fuchsia-400" /> ربط السيرفر بأي عميل MCP
        </h2>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            readOnly
            value={mcpUrl}
            dir="ltr"
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm outline-none"
            aria-label="رابط خادم MCP"
          />
          <CopyBtn text={mcpUrl} />
        </div>

        <div className="mb-4 flex gap-2" role="tablist">
          {([
            ["chatgpt", "ChatGPT / GPT Agents"],
            ["claude", "Claude Desktop"],
            ["cursor", "Cursor / Windsurf / Cline"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${tab === id ? "border border-cyan-500/40 bg-cyan-500/15 text-cyan-200" : "border border-transparent text-slate-400 hover:text-slate-200"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative">
          <pre dir="ltr" className="max-h-64 overflow-auto rounded-xl border border-slate-700/70 bg-slate-950/70 p-4 text-left text-xs leading-relaxed text-slate-200">{configs[tab]}</pre>
          <div className="absolute end-3 top-3"><CopyBtn text={configs[tab]} small /></div>
        </div>
        {tab === "chatgpt" && (
          <p className="mt-2 text-xs text-slate-400">
            في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط أعلاه في «Server URL».
          </p>
        )}
        {tab === "claude" && (
          <p className="mt-2 text-xs text-slate-400">
            انسخ المحتوى إلى ملف <code dir="ltr">claude_desktop_config.json</code> ثم أعد تشغيل Claude Desktop.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2.5">
          {toolChips.map((t) => (
            <span key={t.name} className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-xs" title={t.desc}>
              <t.icon className="h-3.5 w-3.5 text-cyan-400" />
              <code dir="ltr" className="font-semibold text-slate-200">{t.name}</code>
              <span className="text-slate-400">— {t.desc}</span>
            </span>
          ))}
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف.
            أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
          </p>
        </div>
      </section>

      <footer className="mt-10 pb-6 text-center text-xs text-slate-600">
        M-Verdy • توليد الوسائط عبر kie.ai + CometAPI • تخزين روابط فقط في Turso • جاهز للنشر على Vercel
      </footer>
    </main>
  );
}
