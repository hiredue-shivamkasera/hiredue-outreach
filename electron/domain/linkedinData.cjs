// Turns raw LinkedIn page data (response streams, card text) into posts and people. Pure: the adapter collects the raw text, this decides what it means.

const POST_SLUG = /postSlugUrl":"(https:\/\/www\.linkedin\.com\/posts\/[^"]+)"/g;

// Search results stream post links and activity ids in React Server Component payloads, not in the DOM; ported from the desktop app's search-page-scraper.
function parsePostStream(rawText) {
  const text = rawText.replace(/\\"/g, '"').replace(/\\\//g, "/");
  const posts = [];
  let m;
  while ((m = POST_SLUG.exec(text)) !== null) {
    const w = text.substring(Math.max(0, m.index - 3000), Math.min(text.length, m.index + 1000));
    posts.push({ postUrl: m[1], activityId: w.match(/activity:(\d{16,20})/)?.[1] || null });
  }
  const seen = new Set(posts.map((p) => p.activityId).filter(Boolean));
  const reaction = /reactionState-urn:li:activity:(\d{16,20})/g;
  while ((m = reaction.exec(text)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const w = text.substring(Math.max(0, m.index - 3000), Math.min(text.length, m.index + 3000));
    posts.push({ postUrl: w.match(/postSlugUrl":"(https:\/\/www\.linkedin\.com\/posts\/[^"]+)"/)?.[1] || null, activityId: m[1] });
  }
  return posts;
}

const vanityOf = (profileUrl) => String(profileUrl || "").match(/\/in\/([^/?#]+)/)?.[1]?.toLowerCase() || null;

// A post slug starts with the author's vanity name, which is the only key shared by the stream and the DOM card.
function mergePosts(cards, streamed) {
  const byVanity = new Map();
  for (const s of streamed) {
    const vanity = s.postUrl?.match(/\/posts\/([^_]+)_/)?.[1]?.toLowerCase();
    if (!vanity) continue;
    if (!byVanity.has(vanity)) byVanity.set(vanity, []);
    byVanity.get(vanity).push(s);
  }
  return cards.map((card) => {
    const candidates = byVanity.get(vanityOf(card.authorUrl)) || [];
    let best = 0;
    if (candidates.length > 1 && card.text) {
      const words = card.text.toLowerCase().slice(0, 100).split(/\s+/).filter((w) => w.length > 3);
      let bestScore = -1;
      candidates.forEach((c, i) => {
        const slugWords = c.postUrl.toLowerCase().split(/[-_/]/);
        const score = words.filter((w) => slugWords.some((s) => s.includes(w))).length;
        if (score > bestScore) { bestScore = score; best = i; }
      });
    }
    const hit = candidates.splice(best, 1)[0];
    const postUrn = hit?.activityId ? `urn:li:activity:${hit.activityId}` : null;
    return { ...card, postUrl: hit?.postUrl || null, postUrn, postedAt: postedAt(postUrn) };
  });
}

// LinkedIn activity ids carry their creation time in the top 41 bits.
function postedAt(urn) {
  const id = String(urn || "").match(/(\d{16,20})/)?.[1];
  return id ? new Date(Number(BigInt(id) >> 22n)).toISOString() : null;
}

const DEGREE = /^(?:•\s*)?(1st|2nd|3rd\+?)(?:\s+degree(?:\s+connection)?)?$/i;
const NOISE = [/^view .*profile$/i, /^(connect|follow|message|pending|following)$/i, /mutual connection/i, /^status is /i, /followers$/i];
// LinkedIn's "why this matched" lines under a result; kept apart from the headline because they are where a keyword often shows up.
const SNIPPET = /^(current|past|summary|skills|provides services):/i;

// A people-search card's visible text, one line per element: name, degree, headline, location, then buttons and social proof.
function parsePersonCard(lines, profileUrl) {
  let degree = null;
  const kept = [];
  const snippet = [];
  for (const raw of lines) {
    let line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const tail = line.match(/\s*•\s*(1st|2nd|3rd\+?)$/i);
    if (tail) { degree = degree || tail[1]; line = line.slice(0, tail.index).trim(); }
    if (!line) continue;
    const alone = line.match(DEGREE);
    if (alone) { degree = degree || alone[1]; continue; }
    if (NOISE.some((re) => re.test(line))) continue;
    if (SNIPPET.test(line)) { snippet.push(line); continue; }
    if (kept[kept.length - 1] === line) continue;
    kept.push(line);
  }
  const [name = null, headline = null, location = null] = kept;
  return { name, headline, location, degree: degree ? degree.toLowerCase() : null, profileUrl: cleanProfileUrl(profileUrl), snippet: snippet.length ? snippet.join("\n") : null };
}

function cleanProfileUrl(url) {
  const vanity = String(url || "").match(/\/in\/([^/?#]+)/)?.[1];
  return vanity ? `https://www.linkedin.com/in/${vanity}/` : null;
}

// A pasted or API-supplied link, as the item a step can act on. Anything that is not a profile, a company/school/showcase page or a post is null.
function itemFromUrl(raw) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(String(raw)) ? String(raw) : `https://${raw}`); } catch { return null; }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  const path = url.pathname;
  const person = path.match(/^\/in\/([^/]+)/);
  if (person) return { kind: "person", profileUrl: `https://www.linkedin.com/in/${person[1]}/` };
  const page = path.match(/^\/(company|school|showcase)\/([^/]+)/);
  if (page) return { kind: "page", pageUrl: `https://www.linkedin.com/${page[1]}/${page[2]}/` };
  const update = path.match(/^\/feed\/update\/(urn:li:(?:activity|share|ugcPost):\d+)/);
  if (update) return { kind: "post", postUrn: update[1], postUrl: `https://www.linkedin.com/feed/update/${update[1]}/` };
  if (/^\/posts\//.test(path)) {
    const id = path.match(/(?:activity|share|ugcPost)-(\d{16,20})/);
    return { kind: "post", postUrn: id ? `urn:li:activity:${id[1]}` : null, postUrl: `https://www.linkedin.com${path}` };
  }
  return null;
}

module.exports = { parsePostStream, mergePosts, parsePersonCard, cleanProfileUrl, postedAt, itemFromUrl };
