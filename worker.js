// index.js (Cloudflare Workers) - single file
// - GET /                     -> UI page (light theme)
// - POST /v1/chat/completions  -> OpenAI-compatible proxy (Chat Completions)
//   - Uses env defaults (AI_BASE_URL / AI_TOKEN or OPENAI_API_KEY / AI_MODEL / AI_TEMPERATURE / SYSTEM_PROMPT)
//   - Allows per-request overrides via headers from UI:
//       Authorization: Bearer <token>
//       X-AI-Base-URL: https://...
//   - Injects the full domain-bound system prompt as the FIRST system message.
//
// UI Markdown rendering (limited): supports
//   - # / ## / ### headings
//   - - / * unordered lists
//   - **bold**
// No inline code / code blocks.

const DEFAULT_SYSTEM_PROMPT = `# 食品安全与营养相互作用分析助手

## 角色与目标
你是一名**食品安全与营养相互作用分析助手**。  
用户会输入若干食物、材料、调料或补剂（可能包含烹饪方式、用量、食用人群信息）。你的任务是：

1. **逐一分析每种食物/材料的关键组成**：常见营养素、可能引发不适的成分、活性物质、过敏原、刺激性成分、常见污染/食品安全风险点。
2. **基于混合/同餐/同杯/同锅**的组合关系，判断是否存在“吃完可能产生副作用或有害影响”的风险，包括但不限于：
   - 胃肠道不适（胀气、腹泻、反酸、恶心等）
   - 过敏/交叉过敏
   - 药物-食物相互作用（仅当用户提供用药/疾病信息时）
   - 特殊人群风险（孕妇、儿童、老人、肾病/肝病、痛风、糖尿病等）
   - 食品安全风险（生熟交叉、亚硝酸盐/组胺、霉菌毒素、细菌污染、酒精叠加等）
3. 给出**风险等级**与**可操作建议**：如何调整搭配/用量/时间间隔/烹饪方式，或替代方案。
4. 当信息不足以可靠判断时：**先给基于常识的初步评估**，再用**最少的问题**补齐关键信息（最多 3 个问题）。
5. 始终保持谨慎与可解释性：不夸大、不编造“必然中毒”，用“可能/在…情况下风险更高”表述；涉及严重风险时给出明确就医提醒。

---

## 输出结构（必须严格按顺序）
### A. 快速结论（3-6 行）
- **总体风险等级**：低 / 中 / 高 / 不确定（信息不足）
- **主要风险点**（最多 3 条）
- **最关键规避建议**（最多 3 条）

### B. 单品成分拆解（逐项）
对每个食物/材料用项目符号说明：
- 关键成分/活性物质（如咖啡因、组胺、草酸、嘌呤、FODMAP、乳糖等）
- 常见不适或风险点（如刺激性、致敏性、发酵/变质风险、重金属/霉菌等典型风险）
- 哪些人需要特别注意（敏感人群/疾病人群）

### C. 组合相互作用分析
- 逐条说明“哪两种/哪几种”混合**可能**导致什么问题
- 明确触发条件：用量大？空腹？酒精叠加？生食？隔夜？发酵？高温油炸？
- 标注**证据/共识程度**：强 / 中 / 弱（若仅在特定条件或特定人群成立，要写清楚）

### D. 风险分级与依据
- 给出分级理由（不超过 6 条）
- 标注哪些结论是**高确定性**，哪些是**需要更多信息**

### E. 可执行建议
- 更安全的吃法：用量建议、间隔时间、烹饪方式、替代搭配
- 观察与处理：出现哪些不适应停止食用/调整
- **红旗症状**（一旦出现建议尽快就医/急救）：如呼吸困难、喉头/面部肿胀、持续呕吐腹泻导致脱水、意识异常、剧烈腹痛、黑便/血便等

---

## 风险等级定义（必须遵守）
- **低风险**：一般人群同餐通常安全，最多轻微胃肠不适可能
- **中风险**：在较大剂量/空腹/敏感人群/特定做法下更易不适或风险升高
- **高风险**：存在明确食品安全隐患、严重过敏可能、或与常见药物有显著相互作用（仅在信息充分时给高）
- **不确定**：缺少关键条件（是否生食、是否隔夜、是否有基础病/用药/过敏、用量）导致无法可靠判断

---

## 追问规则（最多 3 个问题）
仅当“是否需要规避/是否高风险”依赖关键缺失信息时追问，且最多 3 个：
1) 是否生食/隔夜/发酵/含酒精？  
2) 大概用量与食用频率？  
3) 是否有过敏史、慢病或正在用药？

---

## 表达与安全要求（必须遵守）
- 用词要谨慎：避免“必然”“一定中毒”，优先使用“可能”“在…情况下风险更高”
- 不要编造具体医学结论；若缺乏证据，明确说明“证据有限”
- 遇到高危人群（孕妇、婴幼儿、免疫低下、严重肝肾病等）默认更保守
- 不提供替代医疗诊断；必要时建议咨询医生/药师

---

## 免责声明（必须附在末尾，2-3 行）
本分析为一般性食品安全与营养信息，不构成医疗诊断或个体化治疗建议。  
如出现严重不适或红旗症状，或属于孕妇/慢病/用药人群，请及时咨询医生或药师。`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AI-Base-URL",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/v1/chat/completions") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: cors });
      }
      return proxyChatCompletions(request, env, cors);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function normalizeEndpoint(baseUrl) {
  let u = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (u.endsWith("/v1/chat/completions")) return u;
  if (u.endsWith("/v1")) return u + "/chat/completions";
  return u + "/v1/chat/completions";
}

function parseBearer(authHeader) {
  if (!authHeader) return "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

async function proxyChatCompletions(request, env, cors) {
  const envBase = env.AI_BASE_URL || "https://api.openai.com";
  const envToken = env.AI_TOKEN || env.OPENAI_API_KEY || "";
  const envModel = env.AI_MODEL || "";
  const envTemp =
    env.AI_TEMPERATURE !== undefined && env.AI_TEMPERATURE !== ""
      ? Number(env.AI_TEMPERATURE)
      : undefined;

  const systemPrompt =
    (env.SYSTEM_PROMPT && String(env.SYSTEM_PROMPT)) || DEFAULT_SYSTEM_PROMPT;

  const hdrBase = request.headers.get("X-AI-Base-URL") || "";
  const baseUrl = hdrBase.trim() || envBase;

  const hdrAuth = request.headers.get("Authorization") || "";
  const hdrToken = parseBearer(hdrAuth);

  let token = hdrToken || envToken;
  if (hdrToken && hdrToken.toLowerCase() === "anything" && envToken) token = envToken;

  if (!token) {
    return json(
      {
        error: {
          message:
            "Missing token. Set AI_TOKEN (or OPENAI_API_KEY) in Workers env vars, or pass Authorization: Bearer <token>.",
        },
      },
      400,
      cors
    );
  }

  const upstreamEndpoint = normalizeEndpoint(baseUrl);
  if (!upstreamEndpoint) {
    return json(
      {
        error: {
          message:
            "Missing/invalid base url. Set AI_BASE_URL or pass X-AI-Base-URL.",
        },
      },
      400,
      cors
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON body" } }, 400, cors);
  }

  if (!body || typeof body !== "object") {
    return json({ error: { message: "Body must be a JSON object" } }, 400, cors);
  }
  if (!Array.isArray(body.messages)) {
    return json({ error: { message: "Missing 'messages' array" } }, 400, cors);
  }

  if (!body.model && envModel) body.model = envModel;

  if (body.temperature === undefined && envTemp !== undefined && Number.isFinite(envTemp)) {
    body.temperature = envTemp;
  }

  // Always inject our full system prompt as first message (avoid drift)
  const alreadyHasSame = body.messages.some(
    (m) => m && m.role === "system" && String(m.content || "") === systemPrompt
  );
  if (!alreadyHasSame) {
    body.messages = [{ role: "system", content: systemPrompt }, ...body.messages];
  }

  let resp, text;
  try {
    resp = await fetch(upstreamEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    text = await resp.text();
  } catch (e) {
    return json(
      { error: { message: `Upstream fetch failed: ${String(e?.message || e)}` } },
      502,
      cors
    );
  }

  return new Response(text, {
    status: resp.status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...extraHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function renderHTML() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>食品安全与营养相互作用分析助手</title>
  <style>
    :root{
      --bg:#f6f7fb; --card:#fff; --text:#111827; --muted:#6b7280; --border:#e5e7eb;
      --shadow:0 10px 25px rgba(17,24,39,.08); --shadow2:0 6px 16px rgba(17,24,39,.06);
      --radius:16px; --radius2:12px; --primary:#2563eb; --danger:#ef4444; --ok:#10b981;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    *{box-sizing:border-box}
    body{
      margin:0; font-family:var(--sans); color:var(--text);
      background: radial-gradient(1200px 500px at 10% 0%, rgba(37,99,235,.12), transparent 55%),
                  radial-gradient(900px 500px at 90% 10%, rgba(16,185,129,.10), transparent 55%),
                  var(--bg);
    }
    .page{max-width:980px;margin:0 auto;padding:18px;}
    .topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;}
    .brand{display:flex;align-items:center;gap:10px;min-width:0;}
    .logo{
      width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex:0 0 auto;
      background: linear-gradient(135deg, rgba(37,99,235,.18), rgba(16,185,129,.14));
      border:1px solid rgba(37,99,235,.18); box-shadow:var(--shadow2);
    }
    h1{margin:0;font-size:16px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .sub{margin:2px 0 0 0;font-size:12px;color:var(--muted);}
    .actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px;}
    .btn{
      appearance:none;border:1px solid var(--border);background:#fff;color:var(--text);
      padding:10px 12px;border-radius:12px;cursor:pointer;font-size:13px;
      display:inline-flex;align-items:center;gap:8px;
      transition: transform .05s ease, box-shadow .2s ease, border-color .2s ease, background .2s ease;
      user-select:none;
    }
    .btn:hover{border-color:#d1d5db;box-shadow:0 8px 18px rgba(17,24,39,.06);background:#fcfcff;}
    .btn:active{transform:translateY(1px);}
    .btn.primary{border-color:rgba(37,99,235,.35);background:rgba(37,99,235,.08);color:#0b2a7a;}
    .btn.primary:hover{border-color:rgba(37,99,235,.55);box-shadow:0 12px 22px rgba(37,99,235,.12);}
    .btn.danger{border-color:rgba(239,68,68,.30);background:rgba(239,68,68,.08);color:#7f1d1d;}
    .btn.danger:hover{border-color:rgba(239,68,68,.55);box-shadow:0 12px 22px rgba(239,68,68,.10);}
    .btn:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}

    .intro{
      background: rgba(255,255,255,.85);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow2);
      padding: 12px 14px;
      margin-bottom: 14px;
      display:flex;gap:10px;align-items:flex-start;
    }
    .badge{
      flex:0 0 auto;font-size:12px;padding:4px 10px;border-radius:999px;
      background: rgba(37,99,235,.08);border:1px solid rgba(37,99,235,.18);color:#0b2a7a;
      margin-top:1px;
    }
    .intro b{display:block;font-size:13px;margin-bottom:2px;}
    .intro span{display:block;font-size:12px;color:var(--muted);line-height:1.55;}

    .stack{display:flex;flex-direction:column;gap:14px;}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;}
    .card-header{
      display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
      padding:14px 16px;border-bottom:1px solid var(--border);
      background: linear-gradient(180deg, rgba(255,255,255,.92), rgba(250,251,255,.72));
    }
    .title{display:flex;flex-direction:column;gap:2px;min-width:0;}
    .title b{font-size:14px;letter-spacing:.2px;}
    .title span{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .card-body{padding:14px 16px;display:flex;flex-direction:column;gap:12px;}

    label{font-size:12px;color:var(--muted);margin-bottom:6px;display:block;}
    textarea,input{
      width:100%;border:1px solid var(--border);background:#fff;color:var(--text);
      border-radius:var(--radius2);padding:10px 12px;font-size:14px;outline:none;
      transition: box-shadow .2s ease, border-color .2s ease;
    }
    textarea{resize:vertical;min-height:160px;line-height:1.55;}
    textarea:focus,input:focus{border-color:rgba(37,99,235,.45);box-shadow:0 0 0 4px rgba(37,99,235,.12);}

    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
    .row .spacer{flex:1;}

    .meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end;}
    .chip{
      font-family:var(--mono);font-size:12px;padding:4px 10px;border-radius:999px;
      border:1px solid var(--border);background:#fff;color:var(--muted);
      max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .chip.ok{border-color:rgba(16,185,129,.35);background:rgba(16,185,129,.08);color:#065f46;}
    .chip.bad{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.08);color:#7f1d1d;}

    .output{
      border-top:1px solid var(--border);
      background:#fbfcff;
      padding:14px 16px;
      min-height:240px;max-height:520px;overflow:auto;
    }

    /* Markdown (limited) */
    .md{
      line-height:1.7;
      font-size:14px;
      color: var(--text);
      word-break: break-word;
    }
    .md h1,.md h2,.md h3{
      margin: 14px 0 8px;
      line-height: 1.25;
    }
    .md h1{ font-size: 18px; }
    .md h2{ font-size: 16px; }
    .md h3{ font-size: 15px; }
    .md p{ margin: 8px 0; }
    .md ul{ margin: 8px 0 8px 20px; padding:0; }
    .md li{ margin: 4px 0; }
    .md strong{ font-weight: 700; }
    .md hr{
      border:0;
      border-top:1px solid rgba(17,24,39,.10);
      margin: 14px 0;
    }

    .spinner{
      width:14px;height:14px;border:2px solid rgba(17,24,39,.18);
      border-top-color: rgba(37,99,235,.9);border-radius:50%;
      display:inline-block;animation: spin .75s linear infinite;
    }
    @keyframes spin{to{transform:rotate(360deg);}}

    /* modal */
    .backdrop{
      position:fixed;inset:0;display:none;align-items:center;justify-content:center;
      padding:18px;background:rgba(17,24,39,.35);z-index:50;
    }
    .modal{
      width:min(760px, 100%); background:#fff; border:1px solid var(--border);
      border-radius:var(--radius); box-shadow:0 24px 60px rgba(17,24,39,.18); overflow:hidden;
    }
    .modal-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:12px;}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .form-grid .full{grid-column:1 / -1;}
    @media (max-width:720px){ .form-grid{grid-template-columns:1fr;} .meta{justify-content:flex-start;} }
    .small{font-size:12px;color:var(--muted);line-height:1.55;}
    .hint{
      margin-top:6px;
      font-size:12px;
      color:var(--muted);
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      align-items:center;
    }
    .envtag{
      font-family:var(--mono);
      font-size:12px;
      padding:2px 8px;
      border-radius:999px;
      border:1px solid var(--border);
      background:#fff;
      color:rgba(17,24,39,.75);
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="topbar">
      <div class="brand">
        <div class="logo">🥗</div>
        <div>
          <h1>食品安全与营养相互作用分析助手</h1>
          <p class="sub">Ctrl / ⌘ + Enter 发送</p>
        </div>
      </div>
      <div class="actions">
        <button class="btn" id="btnSettings">⚙️ 设置</button>
        <button class="btn danger" id="btnClear">🧹 清空</button>
      </div>
    </div>

    <div class="intro">
      <div>
        <b>这个助手做什么？</b>
        <span>分析同餐/同杯/同锅的食物、调料、补剂或药物：关键成分、可能不适、食品安全风险，并给出风险等级与可执行建议。</span>
      </div>
    </div>

    <div class="stack">
      <section class="card">
        <div class="card-header">
          <div class="title">
            <b>输入</b>
            <span>描述你要一起吃/喝的东西</span>
          </div>
          <div class="meta">
            <span class="chip" id="chipStatus">idle</span>
          </div>
        </div>
        <div class="card-body">
          <div>
            <textarea id="userInput" placeholder="输入食物/调料/补剂/药物（可加做法、用量、人群信息等）。
例如：可乐, 布洛芬胶囊"></textarea>
          </div>
          <div class="row">
            <button class="btn primary" id="btnSend">
              <span id="sendIcon">🚀</span>
              <span id="sendText">发送</span>
            </button>
            <div class="spacer"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <div class="title">
            <b>输出</b>
          </div>
          <div class="meta">
            <span class="chip" id="chipUpstream">upstream: env</span>
            <span class="chip" id="chipModel">model: (auto)</span>
          </div>
        </div>
        <div class="output"><div class="md" id="output">(等待发送…)</div></div>
      </section>
    </div>
  </div>

  <div class="backdrop" id="backdrop" role="dialog" aria-modal="true">
    <div class="modal">
      <div class="card-header">
        <div class="title">
          <b>设置</b>
        </div>
        <div class="actions">
          <button class="btn" id="btnClose">✖ 关闭</button>
        </div>
      </div>

      <div class="modal-body">
        <div class="form-grid">
          <div class="full">
            <label for="apiBaseUrl">AI Base URL</label>
            <input id="apiBaseUrl" placeholder="例如：https://api.openai.com（留空用 env.AI_BASE_URL）" />
          </div>

          <div class="full">
            <label for="apiToken">Token</label>
            <input id="apiToken" type="password" placeholder="sk-...（留空用 env.AI_TOKEN）" />
          </div>

          <div>
            <label for="model">Model</label>
            <input id="model" placeholder="例如：gpt-4o-mini（留空用 env.AI_MODEL）" />
          </div>

          <div>
            <label for="temperature">Temperature</label>
            <input id="temperature" type="number" min="0" max="2" step="0.1" placeholder="例如：0.7（留空用 env.AI_TEMPERATURE）" />
          </div>

          <div class="full">
            <div class="small">
              提示：可以用 <span class="envtag">SYSTEM_PROMPT</span> 覆盖内置 prompt。
            </div>
          </div>

          <div class="full">
            <div class="row" style="justify-content:flex-end;">
              <button class="btn" id="btnReset">↩ 清空本地设置</button>
              <button class="btn primary" id="btnSave">💾 保存</button>
            </div>
          </div>
        </div>

        <div class="small">本设置仅保存在浏览器的本地缓存，不会上传云端</div>
      </div>
    </div>
  </div>

  <script>
    const LS_KEY = "food_safety_ui_settings_limited_md_v2";
    const $ = (id) => document.getElementById(id);

    const userInput = $("userInput");
    const output = $("output");

    const chipStatus = $("chipStatus");
    const chipUpstream = $("chipUpstream");
    const chipModel = $("chipModel");

    const btnSend = $("btnSend");
    const btnClear = $("btnClear");

    const backdrop = $("backdrop");
    const btnSettings = $("btnSettings");
    const btnClose = $("btnClose");

    const apiBaseUrl = $("apiBaseUrl");
    const apiToken = $("apiToken");
    const modelInput = $("model");
    const temperatureInput = $("temperature");

    const btnSave = $("btnSave");
    const btnReset = $("btnReset");

    let busy = false;

    function safeJsonParse(str){ try { return JSON.parse(str); } catch { return null; } }

    function loadSettings(){
      const s = safeJsonParse(localStorage.getItem(LS_KEY)) || {};
      return {
        apiBaseUrl: (s.apiBaseUrl ?? "").trim(),
        apiToken: (s.apiToken ?? "").trim(),
        model: (s.model ?? "").trim(),
        temperature: (s.temperature ?? "")
      };
    }

    function saveSettings(s){
      localStorage.setItem(LS_KEY, JSON.stringify(s));
    }

    function clearSettings(){
      localStorage.removeItem(LS_KEY);
    }

    function setStatus(t, kind){
      chipStatus.textContent = t;
      chipStatus.classList.remove("ok","bad");
      if (kind === "ok") chipStatus.classList.add("ok");
      if (kind === "bad") chipStatus.classList.add("bad");
    }

    function setBusy(b){
      busy = b;
      btnSend.disabled = b;
      $("sendText").textContent = b ? "发送中..." : "发送";
      $("sendIcon").innerHTML = b ? '<span class="spinner"></span>' : "🚀";
    }

    // -------- Limited Markdown renderer (safe) --------
    // Supports: #/##/### headings, unordered list (-/*), **bold**
    function escapeHtml(s){
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderBold(text){
      return text.replace(/\\*\\*([^*]+?)\\*\\*/g, "<strong>$1</strong>");
    }

    function mdToHtml(md){
      const src = escapeHtml(md).replace(/\\r\\n/g, "\\n");
      const lines = src.split("\\n");

      let html = [];
      let inUl = false;

      function closeUl(){
        if (inUl){ html.push("</ul>"); inUl = false; }
      }

      for (const line of lines){
        if (/^\\s*---\\s*$/.test(line)){
          closeUl();
          html.push("<hr/>");
          continue;
        }

        const h3 = line.match(/^###\\s+(.*)$/);
        const h2 = line.match(/^##\\s+(.*)$/);
        const h1 = line.match(/^#\\s+(.*)$/);
        if (h3){ closeUl(); html.push("<h3>" + renderBold(h3[1]) + "</h3>"); continue; }
        if (h2){ closeUl(); html.push("<h2>" + renderBold(h2[1]) + "</h2>"); continue; }
        if (h1){ closeUl(); html.push("<h1>" + renderBold(h1[1]) + "</h1>"); continue; }

        const li = line.match(/^\\s*([*-])\\s+(.*)$/);
        if (li){
          if (!inUl){ html.push("<ul>"); inUl = true; }
          html.push("<li>" + renderBold(li[2]) + "</li>");
          continue;
        } else {
          closeUl();
        }

        if (/^\\s*$/.test(line)){
          html.push("");
          continue;
        }

        html.push("<p>" + renderBold(line) + "</p>");
      }

      closeUl();
      return html.join("\\n");
    }

    function showMarkdown(raw){
      output.innerHTML = mdToHtml(String(raw ?? "") || "(空回复)");
      output.scrollTop = output.scrollHeight;
    }
    // -----------------------------------------------

    function openModal(){
      const s = loadSettings();
      apiBaseUrl.value = s.apiBaseUrl || "";
      apiToken.value = s.apiToken || "";
      modelInput.value = s.model || "";
      temperatureInput.value = (s.temperature === null || s.temperature === undefined) ? "" : String(s.temperature);
      backdrop.style.display = "flex";
    }
    function closeModal(){ backdrop.style.display = "none"; }

    async function send(){
      const text = userInput.value.trim();
      if (!text) { setStatus("请输入内容", "bad"); return; }
      if (busy) return;

      const s = loadSettings();

      setBusy(true);
      setStatus("requesting...");
      showMarkdown("—— 请求已发送 ——");

      const body = { messages: [{ role: "user", content: text }] };

      if (s.model) body.model = s.model;

      if (s.temperature !== "" && s.temperature !== null && s.temperature !== undefined) {
        const tempNum = Number(s.temperature);
        if (!Number.isFinite(tempNum) || tempNum < 0 || tempNum > 2) {
          setBusy(false);
          setStatus("温度需 0~2", "bad");
          return;
        }
        body.temperature = tempNum;
      }

      const headers = { "Content-Type": "application/json" };
      if (s.apiToken) headers["Authorization"] = "Bearer " + s.apiToken;
      if (s.apiBaseUrl) headers["X-AI-Base-URL"] = s.apiBaseUrl;

      chipUpstream.textContent = "upstream: " + (s.apiBaseUrl ? "override" : "env");
      chipModel.textContent = "model: " + (s.model ? s.model : "(auto)");

      try{
        const resp = await fetch("/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });

        const raw = await resp.text();
        let data = null;
        try { data = JSON.parse(raw); } catch {}

        if (!resp.ok){
          const msg = data?.error?.message || raw || ("HTTP " + resp.status);
          setStatus("error", "bad");
          showMarkdown("# 错误\\n- " + msg);
          return;
        }

        if (data?.model) chipModel.textContent = "model: " + data.model;

        const answer =
          data?.choices?.[0]?.message?.content ??
          data?.choices?.[0]?.text ?? "";

        setStatus("ok", "ok");
        showMarkdown(answer || "(空回复)");
      } catch(e){
        setStatus("network error", "bad");
        showMarkdown("# 网络/请求异常\\n- " + (e?.message || String(e)));
      } finally{
        setBusy(false);
      }
    }

    btnSend.addEventListener("click", send);
    userInput.addEventListener("keydown", (e)=>{ if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send(); });

    btnClear.addEventListener("click", ()=>{
      userInput.value="";
      setStatus("idle");
      showMarkdown("(等待发送…)");
    });

    btnSettings.addEventListener("click", openModal);
    btnClose.addEventListener("click", closeModal);
    backdrop.addEventListener("click", (e)=>{ if (e.target === backdrop) closeModal(); });

    btnReset.addEventListener("click", ()=>{
      clearSettings();
      setStatus("已清空设置", "ok");
      closeModal();
      chipUpstream.textContent = "upstream: env";
      chipModel.textContent = "model: (auto)";
    });

    btnSave.addEventListener("click", ()=>{
      saveSettings({
        apiBaseUrl: apiBaseUrl.value.trim(),
        apiToken: apiToken.value.trim(),
        model: modelInput.value.trim(),
        temperature: temperatureInput.value.trim()
      });
      setStatus("saved", "ok");
      closeModal();
    });

    setStatus("idle");
    showMarkdown("(等待发送…)");
  </script>
</body>
</html>`;
}
