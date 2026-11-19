// Asistente con IA de Vacío Legal CSB (/api/ia): Cloudflare Pages Functions + Workers AI (variable AI, en wrangler.toml).
// Responde solo con el reglamento que trae la propia página (bloque <script id="datos"> de docs/index.html).
// Lo gratis de Workers AI son 10.000 «neuronas» al día para TODA la cuenta (también las usa Surf Maitencillo):
// esta guía se pone un tope propio bajo para no comérselas.
const AI_MAIN = { id: "@cf/google/gemma-4-26b-a4b-it", inM: 9091, outM: 27273 };   // neuronas por millón de tokens
const AI_BACKUP = { id: "@cf/meta/llama-4-scout-17b-16e-instruct", inM: 24545, outM: 77273 };
const CAP = { day: 1500, ipDay: 20, ipMin: 5 }; // neuronas al día para esta guía · preguntas por conexión al día y por minuto
const ORIGINS = ["https://pedrocova13.github.io"]; // la copia de GitHub Pages también puede preguntar
const TABS = { uniforme: "Uniforme", celular: "Celular e IA", faltas: "Faltas", sanciones: "Sanciones", reclamar: "Si te sancionan", derechos: "Derechos" };
const GRAV = { leve: "Leve", mod: "Moderada", grave: "Grave", mgrave: "Muy grave" };

const JSON_H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function cors(request) {
  const o = request.headers.get("origin");
  return ORIGINS.includes(o) ? { "access-control-allow-origin": o, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" } : {};
}
const out = (request, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...JSON_H, ...cors(request) } });

// Topes: se cuentan en la memoria del servidor (es aproximado: Cloudflare puede tener varias copias corriendo).
let use = { day: "", neu: 0, ip: new Map() };
function today() { return new Date().toISOString().slice(0, 10); }
function check(ip) {
  const d = today();
  if (use.day !== d) use = { day: d, neu: 0, ip: new Map() };
  if (use.neu >= CAP.day) return "limit";
  const now = Date.now(), r = use.ip.get(ip) || { n: 0, recent: [] };
  r.recent = r.recent.filter(t => now - t < 60000);
  if (r.n >= CAP.ipDay) return "limit";
  if (r.recent.length >= CAP.ipMin) return "rate";
  r.n++; r.recent.push(now); use.ip.set(ip, r);
  return null;
}

// El reglamento: se lee de la página publicada y se guarda 10 minutos.
let KB = null, KB_AT = 0;
async function loadKB(context) {
  if (KB && Date.now() - KB_AT < 600000) return KB;
  const r = await context.env.ASSETS.fetch(new Request(new URL("/", context.request.url)));
  const m = (await r.text()).match(/<script type="application\/json" id="datos">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("sin datos");
  KB = JSON.parse(m[1]); KB_AT = Date.now();
  return KB;
}
const pg = p => /^[\d–]+$/.test(p) ? "pág. " + p : p;
function kbText(kb, sex) {
  const L = [];
  kb.ITEMS.forEach(it => { if (!it[5] || sex === "ambos" || it[5] === sex) L.push(`[${TABS[it[0]]} › ${it[1]}] ${it[2]}: ${it[3]} (${pg(it[4])})`); });
  kb.FALTAS.forEach(f => L.push(`[Falta n.º ${f[0]}] ${f[1]} → ${GRAV[f[2]]} (págs. 66–70)${f[3] ? " Nota: " + f[3] : ""}`));
  kb.LADDER.forEach(l => L.push(`[Escalera de sanciones] ${l[0]} notificaciones → ${l[1]}: ${l[2]} (pág. ${l[3]})`));
  kb.STEPS.forEach((s, i) => L.push(`[Si te sancionan, paso ${i + 1}] ${s[0]}${s[1] ? " (pág. " + s[1] + ")" : ""}`));
  return L.join("\n");
}
function system(kb, sex) {
  const who = sex === "h" ? "hombre" : sex === "m" ? "mujer" : "no indicado (si la regla cambia según el sexo, da ambas)";
  return `Eres el asistente de "Vacío Legal CSB", una guía no oficial del Reglamento Interno 2026 del Colegio San Benito (Vitacura, Chile, colegio particular pagado). Hablas con un estudiante de 7° básico (Tercer Ciclo). Sexo del estudiante: ${who}.

Cómo responder:
- Español de Chile, simple y directo, como un hermano mayor que sabe del tema. Máximo 120 palabras.
- Usa SOLO la información de la lista de abajo. Después de cada dato pon su página entre paréntesis, tal como aparece en la lista, por ejemplo (pág. 37).
- Si la lista no lo cubre, di "El reglamento no lo contempla" y, solo si la lista trae una regla general que sirva, menciónala.
- Si hay dos lecturas posibles, muestra ambas (la del colegio y la que te favorece).
- Si algo tiene riesgo real de sanción, dilo claro. Si la situación es grave (amenazas, abuso, expulsión), recomienda hablar con un adulto de confianza o un abogado.
- No inventes normas, plazos ni páginas. Usa viñetas con "- " cuando ayuden y **negrita** solo para lo clave. Sin títulos ni tablas.
- Solo hablas del reglamento y de tus derechos en el colegio. Si preguntan otra cosa, di con buena onda que solo hablas de eso.
- Termina siempre con: "Esto es orientativo; para algo formal, consulta a un abogado."

INFORMACIÓN DEL REGLAMENTO:
${kbText(kb, sex)}`;
}
const neurons = (m, i, o) => (i * m.inM + o * m.outM) / 1e6;
const cleanAI = s => String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim().slice(0, 3000);

export const onRequestOptions = ({ request }) => new Response(null, { status: 204, headers: cors(request) });
export const onRequestGet = ({ request, env }) => out(request, { ai: !!env.AI });

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.AI) return out(request, { error: "no-ai" }, 503);
  const txt = await request.text();
  if (txt.length > 20000) return out(request, { error: "Demasiado largo" }, 413);
  let b;
  try { b = JSON.parse(txt); } catch { return out(request, { error: "JSON inválido" }, 400); }
  // la conversación: solo lo que dijo cada uno, lo último hasta ~5.000 letras
  let hist = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-10).map(m => ({ role: m.role, content: m.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 1200) }));
  for (let tot = hist.reduce((s, m) => s + m.content.length, 0); hist.length > 1 && tot > 5000; ) tot -= hist.shift().content.length;
  while (hist.length && hist[0].role !== "user") hist.shift();
  if (!hist.length || hist[hist.length - 1].role !== "user") return out(request, { error: "Falta la pregunta" }, 400);
  const sex = ["h", "m", "ambos"].includes(b.sex) ? b.sex : "ambos";

  const stop = check(request.headers.get("cf-connecting-ip") || "?");
  if (stop) return out(request, { error: stop }, 429);

  let kb;
  try { kb = await loadKB(context); } catch { return out(request, { error: "sin-datos" }, 500); }
  const sys = system(kb, sex);
  const msgs = [{ role: "system", content: sys }, ...hist];
  const inChars = sys.length + hist.reduce((s, m) => s + m.content.length, 0);
  let text = "";
  for (const M of [AI_MAIN, AI_BACKUP]) {
    try {
      const r = await env.AI.run(M.id, M === AI_MAIN
        ? { messages: msgs, max_completion_tokens: 600, temperature: 0.3, chat_template_kwargs: { enable_thinking: false } }
        : { messages: msgs, max_tokens: 600, temperature: 0.3 });
      text = cleanAI((r && (r.response || (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content))) || "");
      const u = (r && r.usage) || {};
      use.neu += neurons(M, u.prompt_tokens || Math.ceil(inChars / 3.2), u.completion_tokens || Math.ceil(text.length / 3.2));
      if (text) break;
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/neuron|allocation|4006|daily free/i.test(m)) return out(request, { error: "limit" }, 429); // se acabó lo gratis de la cuenta
      use.neu += neurons(M, Math.ceil(inChars / 3.2), 0);
    }
  }
  if (!text) return out(request, { error: "ai" }, 502);
  return out(request, { text });
}
