// خادم MCP لتوليد الوسائط — الأدوات الخمس (spec §8)
// النتائج تُصاغ بالعربية؛ أوصاف الأدوات بالإنجليزية لأن عميل MCP يقرأها
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runGeneration, runMerge, refreshTask } from "../generation";
import { listRecentTasks, taskResultUrls, taskStats } from "../tasks";
import type { GenOptions, GenOutcome } from "../generation";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

type Extra = RequestHandlerExtra<never, never>;

/** بث إشعارات التقدم إن زوّد العميل الطلب بـ _meta.progressToken */
function makeNotifier(extra: Extra): GenOptions["notify"] {
  return async (progress: number, total: number, message: string) => {
    const token = extra?._meta?.progressToken;
    if (token === undefined || token === null) return;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      } as never);
    } catch {
      /* إشعارات التقدم اختيارية */
    }
  };
}

/** استخراج الأصل المطلق من رؤوس الطلب الحقيقي — لبناء روابط النتائج المطلقة */
function originFromExtra(extra: Extra): string {
  const headers = (extra?.requestInfo?.headers || {}) as Record<string, string | undefined>;
  const host = headers["x-forwarded-host"] || headers.host;
  if (!host) return process.env.PUBLIC_APP_URL || "";
  const proto =
    headers["x-forwarded-proto"] ||
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function optsFrom(extra: Extra): GenOptions {
  return { origin: originFromExtra(extra), notify: makeNotifier(extra) };
}

function outcomeToText(outcome: GenOutcome): { text: string; isError: boolean } {
  return { text: outcome.message, isError: outcome.kind === "failed" };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function errResult(e: unknown): { content: { type: "text"; text: string }[]; isError: boolean } {
  const msg = e instanceof Error ? e.message : String(e);
  return textResult(`❌ حدث خطأ داخلي غير متوقع: ${msg}`, true);
}

/** إنشاء خادم MCP جديد لكل طلب (وضع عديم الحالة — الأنسب لـ serverless) */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image — توليد صورة بـ gpt-image-2-6/flare-text-to-image (تبديل تلقائي عبر كل المفاتيح النشطة)
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). Returns a ready image URL if completed within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .optional()
          .describe("Image model (default: gpt-image-2-6/flare-text-to-image)"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .optional()
          .describe("Aspect ratio (default auto)"),
        resolution: z.enum(["1K", "2K", "4K"]).optional().describe("Resolution (default 1K)"),
        background: z.enum(["auto", "transparent", "opaque"]).optional().describe("Only applied at 1K (default auto)"),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).optional().describe("Output format (default png)"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(240)
          .optional()
          .describe("How long to wait before returning a task_id (default 90)"),
      },
    },
    async (args, extra) => {
      try {
        const outcome = await runGeneration("image", { ...args }, optsFrom(extra));
        const { text, isError } = outcomeToText(outcome);
        return textResult(text, isError);
      } catch (e) {
        return errResult(e);
      }
    },
  );

  // 2) generate_video — توليد فيديو بـ grok-imagine-video-1-5-preview (صوت متزامن أصلي، image-to-video اختياري)
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Videos take minutes: a short wait with live progress first, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .optional()
          .describe("Video model (default: grok-imagine-video-1-5-preview)"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).optional().describe("Aspect ratio (default auto)"),
        resolution: z.enum(["480p", "720p", "1080p"]).optional().describe("Resolution (default 480p)"),
        enable_audio: z.boolean().optional().describe("Enable native audio (default true)"),
        duration: z.number().int().min(1).max(15).optional().describe("Duration in seconds (default 8)"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(240)
          .optional()
          .describe("How long to wait before returning a task_id (default 25)"),
      },
    },
    async (args, extra) => {
      try {
        const outcome = await runGeneration("video", { ...args }, optsFrom(extra));
        const { text, isError } = outcomeToText(outcome);
        return textResult(text, isError);
      } catch (e) {
        return errResult(e);
      }
    },
  );

  // 3) merge_videos — دمج عدة مقاطع في فيديو واحد نهائي بالترتيب المعطى (بدون resolution/fps — الناتج ثابت)
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Concatenate several finished clips into ONE final video in the given order. Pass 'urls' (public direct video links — like the links from generate_video) or 'task_ids' (completed video generation tasks; their result URLs are merged in this order). Merging is usually fast: a short wait with live progress first, then a merge task_id — track it with get_task. NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(240)
          .optional()
          .describe("How long to wait before returning a task_id (default 60)"),
      },
    },
    async (args, extra) => {
      try {
        const outcome = await runMerge({ ...args }, optsFrom(extra));
        const { text, isError } = outcomeToText(outcome);
        return textResult(text, isError);
      } catch (e) {
        return errResult(e);
      }
    },
  );

  // 4) get_task — تتبع أي مهمة (توليد صور/فيديو ودمج) وتحديثها حيًا من المزود/الخدمة
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its ID — image/video generation AND merging (reads Turso and refreshes live from the provider/service if still running). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1).describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args, extra) => {
      try {
        const outcome = await refreshTask(args.task_id, optsFrom(extra));
        const { text, isError } = outcomeToText(outcome);
        return textResult(text, isError);
      } catch (e) {
        return errResult(e);
      }
    },
  );

  // 5) list_media — أحدث الوسائط المخزنة بروابطها من قاعدة البيانات (بدون إعادة توليد)
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "List the most recent images/videos/merges stored with their result URLs from the database (no regeneration) — use it to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional().describe("Filter by media type"),
        status: z.enum(["completed", "failed", "processing"]).optional().describe("Filter by status"),
        limit: z.number().int().min(1).max(50).optional().describe("How many tasks to return (default 10)"),
      },
    },
    async (args) => {
      try {
        const limit = Math.max(1, Math.min(50, args.limit ?? 10));
        const tasks = await listRecentTasks(limit, { type: args.type, status: args.status });
        if (!tasks.length) {
          return textResult("📭 لا توجد مهام مخزنة حتى الآن" + (args.type ? ` من نوع ${args.type}` : "") + ".");
        }
        const lines: string[] = ["🗂️ أحدث الوسائط المخزنة (من الأحدث):", ""];
        tasks.forEach((t, i) => {
          const statusAr = t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "قيد المعالجة";
          const typeAr = t.type === "image" ? "صورة" : t.type === "merge" ? "دمج" : "فيديو";
          lines.push(`${i + 1}. [${typeAr} • ${statusAr}] task_id: ${t.id}`);
          lines.push(`   الموديل: ${t.model}`);
          if (t.prompt) lines.push(`   الوصف: ${t.prompt.slice(0, 120)}`);
          if (t.created_at) lines.push(`   أُنشئت: ${t.created_at}`);
          const urls = taskResultUrls(t);
          for (const u of urls) lines.push(`   الرابط: ${u}`);
          lines.push("");
        });
        const stats = await taskStats();
        lines.push(
          `الإحصائيات: إجمالي ${stats.total} • مكتملة ${stats.completed} • فاشلة ${stats.failed} • جارية ${stats.processing}`,
        );
        return textResult(lines.join("\n"));
      } catch (e) {
        return errResult(e);
      }
    },
  );

  return server;
}
