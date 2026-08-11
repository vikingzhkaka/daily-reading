// translation-worker.js — Cloudflare Worker
// 处理翻译练习站的两个写操作（均写 GitHub daily-reading 仓库）：
//   POST /api/new-exercise  -> 从 bank.json 随机抽一道没做过的题，写 exercises/<YYYY-MM-DD>.json + 更新 index.json
//   POST /api/submit        -> 接收作答 {date, answer}，写 answers/<YYYY-MM-DD>.json
// 凭证通过 Worker 环境变量注入（GH_PAT / REPO_OWNER / REPO_NAME），不硬编码。

function b64encode(str) {
  // UTF-8 安全 base64
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 通用 GitHub 读取文件（返回 {content, sha, decoded} 或 null）
async function ghRead(owner, name, path, pat) {
  const url = `https://api.github.com/repos/${owner}/${name}/contents/${path}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "translation-worker",
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`ghRead ${path} -> ${r.status} ${await r.text()}`);
  const j = await r.json();
  // base64 -> 字节 -> UTF-8 字符串（atob 出来的是二进制串，必须转回 UTF-8）
  const bin = atob(j.content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder().decode(bytes);
  return { content: j.content, sha: j.sha, decoded: text };
}

// 通用 GitHub 写入文件（创建或更新）
async function ghWrite(owner, name, path, content, pat, sha) {
  const url = `https://api.github.com/repos/${owner}/${name}/contents/${path}`;
  const body = {
    message: `worker: ${path}`,
    content: b64encode(content),
    branch: "main",
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "translation-worker",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ghWrite ${path} -> ${r.status} ${await r.text()}`);
  return await r.json();
}

async function readJson(owner, name, path, pat) {
  const f = await ghRead(owner, name, path, pat);
  if (!f) return null;
  return JSON.parse(f.decoded);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function handleNewExercise(env) {
  const pat = env.GH_PAT;
  const owner = env.REPO_OWNER;
  const name = env.REPO_NAME;

  // 读题库
  const bank = await readJson(owner, name, "docs/exercises/bank.json", pat);
  if (!bank || !Array.isArray(bank)) throw new Error("bank.json 读取失败");

  // 读已出题 index，算出已用过的标题集合（避免重复）
  const exIndex = (await readJson(owner, name, "docs/exercises/index.json", pat)) || [];
  const usedTitles = new Set(exIndex.map((e) => e.title).filter(Boolean));

  const avail = bank.filter((b) => !usedTitles.has(b.title));
  if (avail.length === 0) {
    return new Response(JSON.stringify({ ok: false, msg: "题库已用完" }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
  const pick = avail[Math.floor(Math.random() * avail.length)];

  const date = todayStr();
  const ex = {
    date,
    title: pick.title,
    source_cn: pick.source_cn,
    ref_en: pick.ref_en,
    topic_tags: pick.topic_tags || [],
    year: pick.year,
    month: pick.month,
    set: pick.set,
  };
  const exPath = `docs/exercises/${date}.json`;
  const exFile = await ghRead(owner, name, exPath, pat);
  await ghWrite(owner, name, exPath, JSON.stringify(ex, null, 2), pat, exFile ? exFile.sha : null);

  // 更新 index.json
  const newIndex = exIndex.filter((e) => e.date !== date);
  newIndex.unshift({ date, title: ex.title, topic_tags: ex.topic_tags, source_cn: ex.source_cn, ref_en: ex.ref_en });
  const idxFile = await ghRead(owner, name, "docs/exercises/index.json", pat);
  await ghWrite(owner, name, "docs/exercises/index.json", JSON.stringify(newIndex, null, 2), pat, idxFile ? idxFile.sha : null);

  return new Response(JSON.stringify({ ok: true, exercise: ex }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handleSubmit(env, body) {
  const pat = env.GH_PAT;
  const owner = env.REPO_OWNER;
  const name = env.REPO_NAME;
  const date = (body.date || todayStr()).toString();
  const answer = (body.answer || "").toString().trim();
  if (!answer) return new Response(JSON.stringify({ ok: false, msg: "作答为空" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });

  // 必须有对应题目
  const ex = await readJson(owner, name, `docs/exercises/${date}.json`, pat);
  if (!ex) return new Response(JSON.stringify({ ok: false, msg: "该日期无翻译题" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });

  const ans = {
    date,
    answer,
    submitted_at: new Date().toISOString(),
  };
  const ansPath = `docs/answers/${date}.json`;
  const ansFile = await ghRead(owner, name, ansPath, pat);
  await ghWrite(owner, name, ansPath, JSON.stringify(ans, null, 2), pat, ansFile ? ansFile.sha : null);

  // 同步更新 answers/index.json
  let ansIndex = (await readJson(owner, name, "docs/answers/index.json", pat)) || [];
  ansIndex = ansIndex.filter((a) => a.date !== date);
  ansIndex.unshift({ date, answer, submitted_at: ans.submitted_at });
  const aiFile = await ghRead(owner, name, "docs/answers/index.json", pat);
  await ghWrite(owner, name, "docs/answers/index.json", JSON.stringify(ansIndex, null, 2), pat, aiFile ? aiFile.sha : null);

  return new Response(JSON.stringify({ ok: true, date }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      if (url.pathname === "/api/new-exercise" && request.method === "POST") {
        const r = await handleNewExercise(env);
        return r;
      }
      if (url.pathname === "/api/submit" && request.method === "POST") {
        const body = await request.json();
        return await handleSubmit(env, body);
      }
      return new Response("not found", { status: 404, headers: corsHeaders() });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, msg: String(e.message || e) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }
  },
};
