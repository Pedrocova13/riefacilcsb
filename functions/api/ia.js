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
// Cada regla con su sección (sec) para poder mandar a la IA solo las que sirven.
function kbLines(kb, sex) {
  const L = [];
  kb.ITEMS.forEach(it => { if (!it[5] || sex === "ambos" || it[5] === sex) L.push({ sec: it[1] === "Claves legales" ? "claves" : it[0], t: `[${TABS[it[0]]} › ${it[1]}] ${it[2]}: ${it[3]} (${pg(it[4])})` }); });
  kb.FALTAS.forEach(f => L.push({ sec: "faltas", n: f[0], t: `[Falta n.º ${f[0]}] ${f[1]} → ${GRAV[f[2]]} (págs. 66–70)${f[3] ? " Nota: " + f[3] : ""}` }));
  kb.LADDER.forEach(l => L.push({ sec: "escalera", t: `[Escalera de sanciones] ${l[0]} notificaciones → ${l[1]}: ${l[2]} (pág. ${l[3]})` }));
  kb.STEPS.forEach((s, i) => L.push({ sec: "pasos", t: `[Si te sancionan, paso ${i + 1}] ${s[0]}${s[1] ? " (pág. " + s[1] + ")" : ""}` }));
  return L;
}

// ---- Elegir las reglas que sirven para la pregunta (mandar todo el reglamento gasta ~4 veces más) ----
const norm = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const STOP = new Set("que los las una uno por con para del como puedo puede pueden hay esto eso esta este ser estar tengo cual sobre mas muy pero les sus tus yo ese esa son fue era hace hacer cuando donde porque colegio reglamento dice tiene algo nada todo".split(" "));
const words = s => [...new Set(norm(s).match(/[a-zñ0-9]{3,}/g) || [])].filter(w => !STOP.has(w)).map(w => w.slice(0, 5));
const TOPICS = [ // si la pregunta toca el tema, va la sección entera
  ["uniforme", /unifor|ropa|vest|camis|blusa|pantal|jumper|falda|zapat|calcet|poler|buzo|chaquet|corbat|sweat|chaleco|parka|abrigo|pelo|cabell|barba|aros?\b|piercing|accesor|collar|pulsera|anillo|maquill|una(s)?\b|tatu|gorro|jockey|educacion fisica|ed\.? fisica|deporte|pong|llevar|usar|color|calor|frio|comod|ir al/],
  ["celular", /celul|telefon|movil|audifon|reloj|smartwatch|tablet|computador|notebook|\bia\b|inteligencia|chatgpt|gpt|gemini|tecnolog|pantalla|recreo/],
  ["faltas", /falta|grave|leve|que (me )?pasa si|me pueden (sancionar|castigar|anotar|echar)|es delito/],
  ["sanciones", /sanci|castig|anot|notific|condicional|expuls|cancel|suspen|echar|aula segura|matricul|hoja de vida|registro|que (me )?pasa si|me pueden/],
  ["escalera", /notific|condicional|expuls|cancel|amonest|escalera|cuant/],
  ["pasos", /apel|reclam|recurs|injust|defend|defens|acus|culpa|version|explic|pillar|pillaron|reto|retar|citar|citaron|firm|resoluc|superintend/],
  ["claves", /derech|ley\b|legal|ilegal|abogad|plazo|expuls|cancel|mentir|inocen|apel|reclam|justo|injust/],
  ["derechos", /derech|discrim|digni|revis|mochila|privac|imagen|foto|grab|redes|critic|opin|acoso|bull|maltrat|concienc|evalua|centro de alumnos/],
];
function pickLines(kb, sex, query, opts = {}) {
  const all = kbLines(kb, sex), q = norm(query), qw = words(query);
  const secs = new Set(TOPICS.filter(([, re]) => re.test(q)).map(([s]) => s));
  if (opts.img) secs.add("uniforme");
  if (opts.isCase) ["sanciones", "pasos", "claves", "escalera"].forEach(s => secs.add(s));
  // además, cualquier regla que comparta palabras con la pregunta (las faltas, solo así: son 50)
  const score = l => { const lw = words(l.t); return qw.filter(w => lw.some(x => x.startsWith(w) || w.startsWith(x) && x.length >= 4)).length; };
  const scored = all.map(l => ({ l, s: score(l) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 14).map(x => x.l);
  let pick = all.filter(l => (secs.has(l.sec) && l.sec !== "faltas") || scored.includes(l));
  if (secs.has("faltas") && !pick.some(l => l.sec === "faltas")) pick = pick.concat(all.filter(l => l.sec === "faltas"));
  if (pick.length < 4) pick = all; // no se entendió el tema: va todo
  return pick.map(l => l.t);
}

// ---- Revisión: una segunda pasada compara el borrador con el reglamento y lo corrige ----
// Ve solo las reglas que el borrador cita (por página o n.º de falta) y, si habla de eso, los derechos, pasos y escalera.
const REVIEW_SYS = `Eres un revisor muy estricto. Recibes INFORMACIÓN DEL REGLAMENTO, una PREGUNTA de un estudiante de 7° básico y un BORRADOR de respuesta. Devuelve el borrador corregido.
Corrige solo esto:
1. Cada dato debe decir exactamente lo que dice la información, con su página. Si un dato no está en la información o está mal, corrígelo o bórralo. No agregues datos que no estén en la información.
2. No exageres: una regla vale solo para lo que dice (por ejemplo, "antes de cancelar o expulsar" no es "antes de cualquier sanción"). Di "la ley" solo si la información dice que es de la ley; si la información dice "discutible", no lo presentes como seguro.
3. Revisa cada negación: que ninguna frase diga lo contrario de lo que quiso decir (por ejemplo, "no debió dejarte explicar" en vez de "debió dejarte explicar").
4. Llama "derecho" solo a lo que la información presenta como derecho o garantía.
5. Lo que el borrador cuenta que se ve en una foto, déjalo igual.
Mantén el tono, el formato con "- " y **negrita**, y el largo (máximo 200 palabras). Debe terminar con: "Esto es orientativo; para algo formal, consulta a un abogado."
Responde SOLO con la respuesta final corregida, sin explicar qué cambiaste.`;
// La revisión solo hace falta cuando hay riesgo de error: casos, fotos, derechos, plazos o sanciones fuertes.
const RISKY = /derech|\bley\b|legal|plazo|d[ií]as|apel|reclam|expuls|cancel|condicional|superintend|discutible|inocen|versi[oó]n/i;
function reviewLines(kb, sex, draft) {
  const d = norm(draft);
  const cited = [...draft.matchAll(/p[áa]gs?\.\s*(\d+(?:\s*[–-]\s*\d+)?)/g)].flatMap(m => m[1].split(/\s*[–-]\s*/));
  const faltas = [...draft.matchAll(/n\.?\s*º\s*(\d+)/g)].map(m => +m[1]);
  return kbLines(kb, sex).filter(l => l.sec === "faltas" ? faltas.includes(l.n)
    : (l.sec === "claves" && /derech|ley\b|expuls|cancel|plazo|inocen|apel/.test(d))
    || (l.sec === "pasos" && /apel|reclam|resoluc|version|firm|prueba/.test(d))
    || (l.sec === "escalera" && /notific|condicional|expuls|cancel|amonest/.test(d))
    || cited.some(p => new RegExp("p[áa]gs?\\. [\\d–]*?\\b" + p + "\\b").test(l.t))).map(l => l.t);
}
function system(lines, sex) {
  const who = sex === "h" ? "hombre" : sex === "m" ? "mujer" : "no indicado (si la regla cambia según el sexo, da ambas)";
  return `Eres el asistente de "Vacío Legal CSB", una guía no oficial del Reglamento Interno 2026 del Colegio San Benito (Vitacura, Chile, colegio particular pagado). Hablas con un estudiante de 7° básico (Tercer Ciclo). Sexo del estudiante: ${who}.

Cómo responder:
- Español de Chile, simple y directo, como un hermano mayor que sabe del tema. Máximo 120 palabras para una pregunta corta.
- Si te cuentan un caso que les pasó, puedes usar hasta 200 palabras: revisa cada hecho por separado (qué dice la regla, si el colegio la cumplió o no) y también el procedimiento: si no lo dejaron explicar, tiene derecho a dar su versión antes de que decidan (pág. 87), a pedir la resolución por escrito (pág. 88) y a reclamar a tiempo. Llama "derecho" solo a lo que la lista presenta como derecho o garantía, no a una regla cualquiera.
- Usa SOLO la información de la lista de abajo. Después de cada dato pon su página entre paréntesis, tal como aparece en la lista, por ejemplo (pág. 37).
- Lee cada pregunta pensando en el colegio: por ejemplo, "cómo ir al colegio" o "qué me pongo" es sobre el uniforme. Reúne TODAS las reglas de la lista que sirvan (no solo una o dos) y, si piden "lo más cómodo" o "lo que más se puede", di qué opciones permitidas son las más cómodas.
- La lista trae las reglas que parecen servir para esta pregunta. Si no lo cubre, di "No encontré una regla sobre eso en el reglamento" y, solo si la lista trae una regla general que sirva, menciónala.
- Si hay dos lecturas posibles, muestra ambas (la del colegio y la que te favorece).
- Si algo tiene riesgo real de sanción, dilo claro. Si la situación es grave (amenazas, abuso, expulsión), recomienda hablar con un adulto de confianza o un abogado.
- No inventes normas, plazos ni páginas. Usa viñetas con "- " cuando ayuden y **negrita** solo para lo clave. Sin títulos ni tablas.
- Si te mandan una foto preguntando si algo se puede: di en corto qué ves que importe para el reglamento (ropa, uniforme, zapatos, pelo, aros, piercings, un celular, etc.) y si eso se permite según la lista, con su página. Si no se ve bien o no se puede saber desde una foto (por ejemplo, el largo exacto del jumper o si un color es "llamativo"), dilo. Lo que se ve en una foto es aproximado: dilo. Habla solo de lo que pide la regla: no comentes el cuerpo, la cara ni el aspecto de la persona, y no intentes saber quién es. Si la foto no tiene que ver con el colegio, dilo.
- Solo hablas del reglamento y de tus derechos en el colegio. Si preguntan otra cosa, di con buena onda que solo hablas de eso.
- Termina siempre con: "Esto es orientativo; para algo formal, consulta a un abogado."

INFORMACIÓN DEL REGLAMENTO:
${lines.join("\n")}`;
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
  const last = hist[hist.length - 1];
  const recent = hist.filter(m => m.role === "user").slice(-2).map(m => m.content).join("\n");
  const sys = system(pickLines(kb, sex, recent, { img: !!img, isCase: last.content.length > 250 }), sex);
  let spent = 0; // neuronas de esta pregunta
  const msgs = [{ role: "system", content: sys }, ...hist.slice(0, -1),
    img ? { role: "user", content: [{ type: "text", text: last.content }, { type: "image_url", image_url: { url: img } }] } : last];
  const inChars = sys.length + hist.reduce((s, m) => s + m.content.length, 0) + (img ? 3500 : 0); // ~1.100 tokens la foto
  let text = "";
  for (const M of [AI_MAIN, AI_BACKUP]) {
    try {
      const r = await env.AI.run(M.id, M === AI_MAIN
        ? { messages: msgs, max_completion_tokens: 700, temperature: 0.1, chat_template_kwargs: { enable_thinking: false } }
        : { messages: msgs, max_tokens: 700, temperature: 0.1 });
      text = cleanAI((r && (r.response || (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content))) || "");
      const u = (r && r.usage) || {};
      spent += neurons(M, u.prompt_tokens || Math.ceil(inChars / 3.2), u.completion_tokens || Math.ceil(text.length / 3.2));
      if (text) break;
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/neuron|allocation|4006|daily free/i.test(m)) return out(request, { error: "limit" }, 429); // se acabó lo gratis de la cuenta
      spent += neurons(M, Math.ceil(inChars / 3.2), 0);
    }
  }
  if (!text) { use.neu += spent; return out(request, { error: "ai" }, 502); }
  // segunda pasada (solo si hay riesgo de error): revisar el borrador contra el reglamento; si falla, queda el borrador
  let final = text;
  if (img || last.content.length > 250 || RISKY.test(text)) try {
    const info = reviewLines(kb, sex, text).join("\n");
    const rmsg = [{ role: "system", content: REVIEW_SYS },
      { role: "user", content: `INFORMACIÓN DEL REGLAMENTO:\n${info}\n\nPREGUNTA:\n${last.content}${img ? "\n(El estudiante mandó una foto.)" : ""}\n\nBORRADOR:\n${text}` }];
    const r = await env.AI.run(AI_MAIN.id, { messages: rmsg, max_completion_tokens: 700, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    const fixed = cleanAI((r && (r.response || (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content))) || "");
    const u = (r && r.usage) || {};
    spent += neurons(AI_MAIN, u.prompt_tokens || Math.ceil(rmsg[1].content.length / 3.2 + 300), u.completion_tokens || Math.ceil(fixed.length / 3.2));
    if (fixed.length > 80 && /orientativo/.test(fixed)) final = fixed;
  } catch {}
  use.neu += spent;
  return out(request, { text: final, n: Math.round(spent) });
}
