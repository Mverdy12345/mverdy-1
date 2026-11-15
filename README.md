# M-Verdy — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP** (Model Context Protocol) لتوليد الوسائط بالذكاء الاصطناعي يجمع ثلاث قدرات في أداة واحدة:

1. **توليد صور** من وصف نصي — الموديل المدمج: `gpt-image-2-6/flare-text-to-image`.
2. **توليد فيديو** مع صوت متزامن أصلي — الموديل المدمج: `grok-imagine-video-1-5-preview`.
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة (MP4 — H.264 + AAC — CRF 18).

المشروع تطبيق **Next.js واحد** جاهز للنشر على **Vercel**:

- **خادم MCP** على المسار `/mcp` (نقل Streamable HTTP وفق مواصفات MCP) يعرض **5 أدوات** يستدعيها نموذج الذكاء الاصطناعي من أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK).
- **واجهة ويب عربية RTL** (`/`) لإدارة مفاتيح API، ومتابعة المهام حية، وعرض إعدادات الربط جاهزة للنسخ.
- **صفحة دمج فيديوهات كاملة** (`/merge`) برفع ملفات بالسحب والإفلات، إعادة ترتيب، تقدم حي، وتوثيق API للمطورين.

**قواعد جوهرية:**

- لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا — تُخزَّن **روابط النتائج فقط** في قاعدة Turso.
- المفاتيح تُجرَّب **بترتيب تسلسلي صارم** حسب ترتيب إضافتها مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة — نموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- التوليد غير متزامن: الأداة تعيد `task_id` فورًا (مع نافذة انتظار تبث تقدمًا حيًا)، والعميل يتابع بأداة `get_task` كل ~10 ثوانٍ.

---

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` — يعيد رابط الصورة جاهزًا إن اكتملت خلال نافذة الانتظار، وإلا `task_id` |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت متزامن، image-to-video اختياري، مدة 1–15 ثانية) |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` (روابط مباشرة) أو `task_ids` (مهام مكتملة تُحل روابطها بالترتيب) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — حدّثها حيًا من المزود/الخدمة ثم اعرض الروابط |
| `list_media` | أحدث الوسائط المخزنة بروابطها من قاعدة البيانات |

مثال `tools/list` عبر curl:

```bash
curl -s -X POST https://<your-app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

مثال توليد صورة:

```bash
curl -s -X POST https://<your-app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a cute orange cat, studio lighting","aspect_ratio":"1:1"}}}'
```

---

## النشر على Vercel خطوة بخطوة

### 1) إنشاء قاعدة Turso (مجانية)

```bash
# ثبّت Turso CLI أولًا: https://docs.turso.tech/cli/installation
turso db create mverdy
turso db show mverdy --url          # ← هذا TURSO_DATABASE_URL (يبدأ بـ libsql://)
turso db tokens create mverdy       # ← هذا TURSO_AUTH_TOKEN
```

### 2) اربط المستودع بـ Vercel

1. ارفع المشروع إلى GitHub (انتهى — المستودع: `https://github.com/Mverdy12345/mverdy-1`).
2. افتح [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → اختر `Mverdy12345/mverdy-1`.
3. قبل الضغط على Deploy: افتح **Environment Variables** وأضف:

| المتغير | القيمة | ملاحظة |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://mverdy-mverdy.aws-us-east-1.turso.io` | إلزامي |
| `TURSO_AUTH_TOKEN` | (توكن Turso) | إلزامي |
| `MCP_ACCESS_TOKEN` | (اختياري) | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` ويظهر في الواجهة |
| `MERGER_API_BASE` | (اختياري) | افتراضيًا الدمج **مدمج داخل التطبيق** ولا حاجة له |

4. اضغط **Deploy** — كل شيء يعمل لأن libSQL يتصل عبر HTTP (مناسب للـ serverless) ومسار `/mcp` يدعم الـ streaming ولا يعتمد على أي ملف محلي.

### 3) أضف مفتاح kie.ai من الواجهة

بعد أول Deploy: افتح `https://<your-app>.vercel.app/` → بطاقة **مدير المفاتيح** → اختر المزود `kie.ai` → الصق المفتاح → إضافة. أضف عدة مفاتيح إن أردت — التجربة تسلسلية (أول مفتاح ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.

### 4) اربط عميل MCP

- **ChatGPT:** Settings → Connectors → Create → Custom MCP server وضع `https://<your-app>.vercel.app/mcp` في «Server URL».
- **Claude Desktop:** ملف `claude_desktop_config.json`:
  ```json
  { "mcpServers": { "media-generator": { "type": "http", "url": "https://<your-app>.vercel.app/mcp" } } }
  ```
- **Cursor / Windsurf / Cline:** نفس صيغة `mcp.json` (بدون `"type"`).

الواجهة تعرض كل هذه الصيغ جاهزة للنسخ في بطاقة **ربط السيرفر**.

---

## متغيرات البيئة

| المتغير | إلزامي؟ | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso `libsql://…` |
| `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
| `MCP_ACCESS_TOKEN` | لا | حماية `/mcp` بمفتاح Bearer |
| `MERGER_API_BASE` | لا | خدمة دمج خارجية — الافتراضي: الدمج مدمج في التطبيق |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز أسماء الموديلات |
| `MAX_SOURCES` / `SOURCE_MAX_MB` / `OUTPUT_MAX_MB` / `MAX_TOTAL_DURATION_SEC` / `FFMPEG_PRESET` | لا | حدود الدمج (10 / 200 / 150 / 600 / medium) |

> `.env*` مُستثنى من Git منذ أول commit — لا أسرار في المستودع إطلاقًا.

---

## واجهة API العامة (خدمة الدمج — بدون تسجيل دخول، CORS مفتوح، الأخطاء بصيغة `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج `{"videos":["...","..."]}` أو `{"sources":[{"kind":"url","url":...},{"kind":"file",...}]}` |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن ~10–15 ثانية) → رابط الفيديو النهائي |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range (206)، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/health` | حالة الخدمة: قاعدة البيانات، الموديلات، خدمة الدمج |
| `GET` | `/api/keys` + `POST` + `PATCH/DELETE /api/keys/{id}` | إدارة المفاتيح (مقنعة دائمًا) |
| `GET` | `/api/tasks?limit=20` | لوحة المهام (إحصائيات + أحدث المهام) |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي 3 صباحًا في vercel.json) |

أمثلة curl كاملة داخل صفحة `/merge` (قسم «توثيق API» قابل للطي).

### حالة مهمة الدمج (مثال)

```json
{ "jobId": "…", "status": "done", "progress": 100,
  "videoUrl": "https://<app>/api/jobs/<id>/video",
  "downloadUrl": "https://<app>/api/jobs/<id>/video?download=1",
  "size": 3466678, "duration": 20.03, "resolution": "640x360", "expiresAt": "…" }
```

---

## محرك الدمج (جودة عالية إلزامية)

- ffprobe لكل مصدر: الدقة، المدة، وجود صوت.
- توحيد كل المصادر عبر `filter_complex`: scale + pad إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080، أبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p`، ثم `concat=n=:v=1:a=1`.
- مصدر بلا صوت؟ يُضاف مسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج.
- الترميز النهائي: `libx264 CRF 18` + `AAC 192k/44100Hz` + `+faststart` — MP4 يعمل فورًا على الويب.
- تقدم الترميز من `-progress pipe:1` (0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال).
- ثنائي ffmpeg يُنسخ إلى `/tmp` بصلاحية 755 عند فقدان صلاحية التنفيذ في الاستضافة.

## التخزين والحذف التلقائي (24 ساعة)

- جداول Turso: `tasks`, `api_keys`, `jobs`, `sources`, `source_chunks`, `output_chunks` — تُنشأ بـ `CREATE TABLE IF NOT EXISTS` عند أول وصول.
- كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا مع تقليم أول/آخر جزء حسب Range.
- `expires_at = created_at + 24 ساعة`؛ التنظيف كسول عند كل إنشاء/دمج + نقطة `/api/cron` يوميًا.
- بعد نجاح الدمج تُحذف `source_chunks` — الناتج فقط هو المطلوب.

## حدود الخطة المجانية المعروفة

- **Vercel Hobby:** مدة الدالة حتى 300 ثانية مع Fluid compute؛ حد حجم الطلب ≈ 4.5MB (لهذا الرفع بأجزاء 4MB)؛ لا نظام ملفات دائم (`/tmp` فقط أثناء المعالجة).
- **Turso المجانية:** قيود على عدد الصفوف/التخزين — احذف المهام الكبيرة بانتظام (`DELETE /api/jobs/{id}` يزيل كل الصفوف).
- **kie.ai:** التوليد مدفوع بالرصيد — عند نفاد الرصيد تُعلَّم المهمة «بانتظار توفر مفتاح صالح…» وتكتمل تلقائيًا فور شحن الرصيد مع كل `get_task`.

## التشغيل المحلي

```bash
cp .env.example .env      # وضع قيم Turso الحقيقية
npm install
npm run dev               # http://localhost:3000
```

## ملاحظات

- وضع MCP عديم الحالة (stateless): خادم لكل طلب — الأنسب لبيئة serverless ولا يفقد شيئًا عند إعادة التدوير.
- اختبار e2e موثق: توليد صورة حقيقي عبر مفتاح خاطئ أولًا ثم صحيح (تبديل تسلسلي صامت، مفتاح خاطئ صار `disabled`)، دمج مقطعين بدقتين مختلفتين (توحيد scale/pad، صوت AAC، مدة = مجموع المدد)، بث الناتج مع Range 206.
- روابط نتائج التوليد تبقى على بنية المزود (kie.ai) — السيرفر يخزن الروابط فقط.
