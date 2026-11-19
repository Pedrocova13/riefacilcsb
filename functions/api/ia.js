// Asistente con IA de Vacío Legal CSB (/api/ia): Cloudflare Pages Functions + Workers AI (variable AI, en wrangler.toml).
// Responde solo con el reglamento que trae la propia página (bloque <script id="datos"> de docs/index.html).
// Lo gratis de Workers AI son 10.000 «neuronas» al día para TODA la cuenta (también las usa Surf Maitencillo):
// esta guía se pone un tope propio bajo para no comérselas.
const AI_MAIN = { id: "@cf/google/gemma-4-26b-a4b-it", inM: 9091, outM: 27273 };   // neuronas por millón de tokens
const AI_BACKUP = { id: "@cf/meta/llama-4-scout-17b-16e-instruct", inM: 24545, outM: 77273 };
const CAP = { day: 1500, ipDay: 20, ipMin: 5, ipImg: 6 }; // neuronas al día para esta guía · preguntas por conexión al día y por minuto · fotos por conexión al día
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
function check(ip, img) {
  const d = today();
  if (use.day !== d) use = { day: d, neu: 0, ip: new Map() };
  if (use.neu >= CAP.day) return "limit";
  const now = Date.now(), r = use.ip.get(ip) || { n: 0, img: 0, recent: [] };
  r.recent = r.recent.filter(t => now - t < 60000);
  if (r.n >= CAP.ipDay) return "limit";
  if (img && r.img >= CAP.ipImg) return "limit-img";
  if (r.recent.length >= CAP.ipMin) return "rate";
  r.n++; if (img) r.img++; r.recent.push(now); use.ip.set(ip, r);
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
function kbText(kb, sex) { return kbLines(kb, sex).join("\n"); }
function kbLines(kb, sex) {
  const L = [];
  kb.ITEMS.forEach(it => { if (!it[5] || sex === "ambos" || it[5] === sex) L.push(`[${TABS[it[0]]} › ${it[1]}] ${it[2]}: ${it[3]} (${pg(it[4])})`); });
  kb.FALTAS.forEach(f => L.push(`[Falta n.º ${f[0]}] ${f[1]} → ${GRAV[f[2]]} (págs. 66–70)${f[3] ? " Nota: " + f[3] : ""}`));
  kb.LADDER.forEach(l => L.push(`[Escalera de sanciones] ${l[0]} notificaciones → ${l[1]}: ${l[2]} (pág. ${l[3]})`));
  kb.STEPS.forEach((s, i) => L.push(`[Si te sancionan, paso ${i + 1}] ${s[0]}${s[1] ? " (pág. " + s[1] + ")" : ""}`));
  return L;
}

// ---- Revisión: una segunda pasada compara el borrador con el reglamento y lo corrige ----
// Ve solo las reglas que el borrador cita (por página) más los derechos y pasos clave, para gastar poco.
const REVIEW_SYS = `Eres un revisor muy estricto. Recibes INFORMACIÓN DEL REGLAMENTO, una PREGUNTA de un estudiante de 7° básico y un BORRADOR de respuesta. Devuelve el borrador corregido.
Corrige solo esto:
1. Cada dato debe decir exactamente lo que dice la información, con su página. Si un dato no está en la información o está mal, corrígelo o bórralo. No agregues datos que no estén en la información.
2. No exageres: una regla vale solo para lo que dice (por ejemplo, "antes de cancelar o expulsar" no es "antes de cualquier sanción"). Di "la ley" solo si la información dice que es de la ley; si la información dice "discutible", no lo presentes como seguro.
3. Revisa cada negación: que ninguna frase diga lo contrario de lo que quiso decir (por ejemplo, "no debió dejarte explicar" en vez de "debió dejarte explicar").
4. Llama "derecho" solo a lo que la información presenta como derecho o garantía.
5. Lo que el borrador cuenta que se ve en una foto, déjalo igual.
Mantén el tono, el formato con "- " y **negrita**, y el largo (máximo 200 palabras). Debe terminar con: "Esto es orientativo; para algo formal, consulta a un abogado."
Responde SOLO con la respuesta final corregida, sin explicar qué cambiaste.`;
function reviewLines(kb, sex, draft) {
  const cited = [...draft.matchAll(/p[áa]gs?\.\s*(\d+(?:\s*[–-]\s*\d+)?)/g)].flatMap(m => m[1].split(/\s*[–-]\s*/));
  return kbLines(kb, sex).filter(l => /^\[(Derechos › Claves legales|Si te sancionan|Escalera)/.test(l)
    || cited.some(p => new RegExp("p[áa]gs?\\. [\\d–]*?\\b" + p + "\\b").test(l)));
}
function system(kb, sex) {
  const who = sex === "h" ? "hombre" : sex === "m" ? "mujer" : "no indicado (si la regla cambia según el sexo, da ambas)";
  return `Eres el asistente de "Vacío Legal CSB", una guía no oficial del Reglamento Interno 2026 del Colegio San Benito (Vitacura, Chile, colegio particular pagado). Hablas con un estudiante de 7° básico (Tercer Ciclo). Sexo del estudiante: ${who}.

Cómo responder:
- Español de Chile, simple y directo, como un hermano mayor que sabe del tema. Máximo 120 palabras para una pregunta corta.
- Si te cuentan un caso que les pasó, puedes usar hasta 200 palabras: revisa cada hecho por separado (qué dice la regla, si el colegio la cumplió o no) y también el procedimiento: si no lo dejaron explicar, tiene derecho a dar su versión antes de que decidan (pág. 87), a pedir la resolución por escrito (pág. 88) y a reclamar a tiempo. Llama "derecho" solo a lo que la lista presenta como derecho o garantía, no a una regla cualquiera.
- Usa SOLO la información de la lista de abajo. Después de cada dato pon su página entre paréntesis, tal como aparece en la lista, por ejemplo (pág. 37).
- Lee cada pregunta pensando en el colegio: por ejemplo, "cómo ir al colegio" o "qué me pongo" es sobre el uniforme. Reúne TODAS las reglas de la lista que sirvan (no solo una o dos) y, si piden "lo más cómodo" o "lo que más se puede", di qué opciones permitidas son las más cómodas.
- Si la lista no lo cubre, di "El reglamento no lo contempla" y, solo si la lista trae una regla general que sirva, menciónala.
- Si hay dos lecturas posibles, muestra ambas (la del colegio y la que te favorece).
- Si algo tiene riesgo real de sanción, dilo claro. Si la situación es grave (amenazas, abuso, expulsión), recomienda hablar con un adulto de confianza o un abogado.
- No inventes normas, plazos ni páginas. Usa viñetas con "- " cuando ayuden y **negrita** solo para lo clave. Sin títulos ni tablas.
- Si te mandan una foto preguntando si algo se puede: di en corto qué ves que importe para el reglamento (ropa, uniforme, zapatos, pelo, aros, piercings, un celular, etc.) y si eso se permite según la lista, con su página. Si no se ve bien o no se puede saber desde una foto (por ejemplo, el largo exacto del jumper o si un color es "llamativo"), dilo. Lo que se ve en una foto es aproximado: dilo. Habla solo de lo que pide la regla: no comentes el cuerpo, la cara ni el aspecto de la persona, y no intentes saber quién es. Si la foto no tiene que ver con el colegio, dilo.
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
  if (txt.length > 2500000) return out(request, { error: "Demasiado grande" }, 413);
  let b;
  try { b = JSON.parse(txt); } catch { return out(request, { error: "JSON inválido" }, 400); }
  // la conversación: solo lo que dijo cada uno, lo último hasta ~5.000 letras
  let hist = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-10).map(m => ({ role: m.role, content: m.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 2500) }));
  for (let tot = hist.reduce((s, m) => s + m.content.length, 0); hist.length > 1 && tot > 8000; ) tot -= hist.shift().content.length;
  while (hist.length && hist[0].role !== "user") hist.shift();
  if (!hist.length || hist[hist.length - 1].role !== "user") return out(request, { error: "Falta la pregunta" }, 400);
  const sex = ["h", "m", "ambos"].includes(b.sex) ? b.sex : "ambos";
  // la foto (opcional) va con la última pregunta; no se guarda en ningún lado
  const img = typeof b.image === "string" && b.image.length < 2000000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.image) ? b.image : null;
  if (b.image && !img) return out(request, { error: "foto" }, 400);

  const stop = check(request.headers.get("cf-connecting-ip") || "?", !!img);
  if (stop) return out(request, { error: stop }, 429);

  let kb;
  try { kb = await loadKB(context); } catch { return out(request, { error: "sin-datos" }, 500); }
  const sys = system(kb, sex);
  const last = hist[hist.length - 1];
  const msgs = [{ role: "system", content: sys }, ...hist.slice(0, -1),
    img ? { role: "user", content: [{ type: "text", text: last.content }, { type: "image_url", image_url: { url: img } }] } : last];
  const inChars = sys.length + hist.reduce((s, m) => s + m.content.length, 0) + (img ? 3500 : 0); // ~1.100 tokens la foto
  let text = "";
  for (const M of [AI_MAIN, AI_BACKUP]) {
    try {
      const r = await env.AI.run(M.id, M === AI_MAIN
        ? { messages: msgs, max_completion_tokens: 900, temperature: 0.1, chat_template_kwargs: { enable_thinking: false } }
        : { messages: msgs, max_tokens: 900, temperature: 0.1 });
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
  // segunda pasada: revisar el borrador contra el reglamento (si falla, queda el borrador)
  let final = text;
  try {
    const info = reviewLines(kb, sex, text).join("\n");
    const rmsg = [{ role: "system", content: REVIEW_SYS },
      { role: "user", content: `INFORMACIÓN DEL REGLAMENTO:\n${info}\n\nPREGUNTA:\n${last.content}${img ? "\n(El estudiante mandó una foto.)" : ""}\n\nBORRADOR:\n${text}` }];
    const r = await env.AI.run(AI_MAIN.id, { messages: rmsg, max_completion_tokens: 900, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    const fixed = cleanAI((r && (r.response || (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content))) || "");
    const u = (r && r.usage) || {};
    use.neu += neurons(AI_MAIN, u.prompt_tokens || Math.ceil(rmsg[1].content.length / 3.2 + 300), u.completion_tokens || Math.ceil(fixed.length / 3.2));
    if (fixed.length > 80 && /orientativo/.test(fixed)) final = fixed;
  } catch {}
  return out(request, { text: final });
}
