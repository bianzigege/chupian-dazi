// Shared bits for the 出片搭子 API.
export const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

// Vision models wrap JSON in prose or code fences now and then; take the outermost object.
export const parseLoose = s => {
  const a = String(s || "").indexOf("{"), b = String(s || "").lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
};

let SPOTS = null;
export async function loadSpots(env, request) {
  if (SPOTS) return SPOTS;
  try { SPOTS = await env.ASSETS.fetch(new URL("/data/pian/spots.json", request.url)).then(r => r.json()); }
  catch (e) { return { spots: [], common_rules: [] }; }
  return SPOTS;
}

export function findCard(data, spotId, cardIdx) {
  const spot = (data.spots || []).find(s => s.id === String(spotId || "")) || null;
  const i = Number.isInteger(cardIdx) ? cardIdx : -1;
  return { spot, card: spot && spot.cards[i] ? spot.cards[i] : null };
}
