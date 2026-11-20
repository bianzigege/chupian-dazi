// POST /api/pian/look {image, spot, card} — 「出片搭子」看构图: one camera frame in, concrete moves out.
// 百炼 qwen3-vl-plus looks at the frame; the spot's own card (what this shot should be) and its etiquette rules
// are passed in so the advice is about this place, not generic photo tips.
import { chat, guard, json } from "../../_lib/bailian.js";
import { clip, findCard, loadSpots, parseLoose } from "../../_lib/pian.js";

export async function onRequestPost({ request, env }) {
  const blocked = await guard(request, env, "look");
  if (blocked) return blocked;
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "请求格式不对" }, 400); }
  const image = typeof b.image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.image) && b.image.length < 1.6e6 ? b.image : null;
  if (!image) return json({ error: "先对着景拍一帧" }, 400);

  try {
    const data = await loadSpots(env, request);
    const { spot, card } = findCard(data, b.spot, b.card);
    const ctx = spot
      ? `地点：${spot.name}。${card ? `想拍的机位「${card.t}」：站位＝${card.where}；拍法＝${card.shot}；姿势＝${card.pose}` : "还没选机位"}
这里的规矩：${[...(data.common_rules || []), ...(spot.rules || [])].join(" ")}`
      : `地点未知。通用规矩：${(data.common_rules || []).join(" ")}`;
    const r = await chat(env, {
      model: "qwen3-vl-plus", temperature: 0.2, max_tokens: 500, timeout: 30000,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: image } },
        { type: "text", text: `你是陪朋友旅行拍照的搭子，朋友举着手机让你看取景画面。只根据画面里真实看到的东西说话，看不清就说看不清。
${ctx}
输出 JSON，不要别的文字：
{"see":"画面里现在有什么，≤24字","score":1到5的整数（5=可以直接按快门）,"moves":["下一步怎么动，最多3条，每条≤18字，要具体：往哪走几步、手机抬高还是放低、把什么放到画面哪里、什么东西切掉了"],"pose":"画面里有人才给一句姿势建议；画面里没有人必须是空字符串，≤20字","rule":"画面里如果有违反上面规矩的情况（着装、爬上底座、禁拍区域等）就提醒一句，没有就空，≤24字","ok":true或false（score≥4 为 true）}
score 是 5 时 moves 最多 1 条或者为空。
要求：不夸不贬，像朋友在旁边说话；不要讲摄影术语（不说「黄金分割」「景深」），说「放到右上角」「蹲低一点」这种话；地平线或建筑歪了要指出来；主体被切掉要指出来。` },
      ] }],
    });
    const j = parseLoose(r.text);
    if (!j) return json({ error: "没看清，再对准拍一次" }, 422);
    const score = Math.max(1, Math.min(5, Math.round(Number(j.score) || 3)));
    const moves = (Array.isArray(j.moves) ? j.moves : []).map(x => clip(x, 30)).filter(Boolean).slice(0, 3);
    return json({ see: clip(j.see, 40), score, ok: score >= 4, moves, pose: clip(j.pose, 36), rule: clip(j.rule, 40) });
  } catch (e) {
    return json({ error: e.message || "没看清，再试一次" }, 502);
  }
}
