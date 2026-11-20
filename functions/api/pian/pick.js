// POST /api/pian/pick {images[≤9], spot, note} — 「出片搭子」挑图 + 文案.
// Step 1: 百炼 qwen3-vl-plus sees all photos, ranks them and says what is actually in each.
// Step 2: 百炼 qwen3.8-flash writes the 小红书 post from those descriptions + the spot's own facts only,
// so the copy cannot invent prices, opening hours or things that are not in the photos.
import { chat, chatJSON, guard, json } from "../../_lib/bailian.js";
import { clip, findCard, loadSpots, parseLoose } from "../../_lib/pian.js";

export async function onRequestPost({ request, env }) {
  const blocked = await guard(request, env, "pick");
  if (blocked) return blocked;
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "请求格式不对" }, 400); }
  const images = (Array.isArray(b.images) ? b.images : [])
    .filter(x => typeof x === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(x) && x.length < 6e5).slice(0, 9);
  if (images.length < 2) return json({ error: "至少选 2 张照片" }, 400);
  const note = clip(b.note, 80);

  try {
    const data = await loadSpots(env, request);
    const { spot } = findCard(data, b.spot, -1);
    const n = images.length, top = Math.min(3, n);
    const r = await chat(env, {
      model: "qwen3-vl-plus", temperature: 0.2, max_tokens: 1200, timeout: 50000,
      messages: [{ role: "user", content: [
        ...images.flatMap((url, i) => [{ type: "text", text: `第 ${i + 1} 张：` }, { type: "image_url", image_url: { url } }]),
        { type: "text", text: `上面是同一趟旅行拍的 ${n} 张照片。帮朋友挑出最适合发小红书的 ${top} 张。
只根据照片里真实看到的内容判断，输出 JSON，不要别的文字：
{"photos":[{"i":照片序号,"what":"这张拍到了什么，≤20字","good":"好在哪，≤18字","bad":"问题在哪（糊、歪、主体被切、太暗、路人抢镜、闭眼等），没有就空，≤18字","score":1到10}],"top":[按发布顺序排的 ${top} 个序号，第一个当封面],"cover_why":"为什么第一张当封面，≤24字"}
photos 要包含全部 ${n} 张。全黑、纯色、严重模糊、不是旅行照片（菜单、截图、文字）的，score 给 1 或 2，并在 bad 里写明。认不出是哪里就只描述看到的东西，不要猜地名。挑封面看：主体清楚、构图干净、颜色抓眼。相似的照片只留一张。` },
      ] }],
    });
    const v = parseLoose(r.text);
    if (!v || !Array.isArray(v.photos)) return json({ error: "照片没看清，换几张再试" }, 422);
    const photos = v.photos.map(p => ({ i: Math.round(Number(p.i)), what: clip(p.what, 30), good: clip(p.good, 28), bad: clip(p.bad, 28), score: Math.max(1, Math.min(10, Math.round(Number(p.score) || 5))) }))
      .filter(p => p.i >= 1 && p.i <= n);
    // Unusable shots (black, blurred, not a travel photo) never make the cut, whatever order the model returned.
    const usable = new Set(photos.filter(p => p.score >= 3).map(p => p.i));
    if (usable.size < 2) return json({ error: "这几张里能发的不到 2 张（太暗、太糊或不是旅行照片），换几张再试", photos }, 422);
    const seen = new Set();
    let order = (Array.isArray(v.top) ? v.top : []).map(x => Math.round(Number(x))).filter(i => i >= 1 && i <= n && usable.has(i) && !seen.has(i) && seen.add(i)).slice(0, top);
    // Fall back to the scores when the model returned no usable order.
    for (const p of [...photos].sort((a, c) => c.score - a.score)) { if (order.length >= top) break; if (usable.has(p.i) && !seen.has(p.i)) { seen.add(p.i); order.push(p.i); } }

    const picked = order.map(i => photos.find(p => p.i === i)).filter(Boolean);
    const facts = (spot ? `地点：${spot.name}（曼谷）。${spot.why}` : "地点：泰国（具体地点以照片为准）") + ` 规矩：${[...((spot && spot.rules) || []), ...(data.common_rules || [])].join(" ")}`;
    const { j } = await chatJSON(env, {
      model: "qwen3.8-flash", temperature: 0.7, max_tokens: 900,
      messages: [
        { role: "system", content: `你帮朋友写一条小红书旅行笔记。只能用下面给的事实：照片里拍到的东西、地点说明、朋友自己补充的话。地点说明只在和照片内容对得上时才用，对不上就只写照片里的东西；不要写「听说」「据说」。不要编价格、开放时间、交通方式、排队时长，也不要编朋友没说过的经历和细节（比如用了什么 App、穿了什么鞋）。
输出 JSON：{"titles":["3 个标题，每个≤20字，可以带 1 个 emoji"],"body":"正文，120–200字，分 3–4 段，第一人称，口语，像真人发的；最后一段是给后来人的 1–2 条实用提醒（只能来自「规矩」或照片里看得出的事）","tags":["6–8 个话题标签，不带 #"]}
不要用「绝绝子」「宝藏」「谁懂啊」这类套话，不要感叹号连用。` },
        { role: "user", content: `${facts}\n选中的照片（按发布顺序）：\n${picked.map((p, k) => `${k + 1}. ${p.what}`).join("\n")}\n朋友补充：${note || "（没有）"}` },
      ],
    });
    return json({
      photos, top: order, cover_why: clip(v.cover_why, 40),
      titles: (Array.isArray(j.titles) ? j.titles : []).map(x => clip(x, 30)).filter(Boolean).slice(0, 3),
      body: String(j.body || "").trim().slice(0, 600),
      tags: (Array.isArray(j.tags) ? j.tags : []).map(x => clip(x, 16).replace(/^#/, "")).filter(Boolean).slice(0, 8),
    });
  } catch (e) {
    return json({ error: e.message || "没挑出来，再试一次" }, 502);
  }
}
