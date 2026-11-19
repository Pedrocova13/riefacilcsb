# Vacío Legal CSB

Guía interactiva y no oficial del Reglamento Interno 2026 del Colegio San Benito para estudiantes de 7° básico.
Pregunta si eres hombre o mujer y muestra el uniforme, las reglas del celular y la IA, las 50 faltas,
la escalera de sanciones, qué hacer si te sancionan y tus derechos, con la página del reglamento citada.
Tiene un buscador y un asistente con IA que acepta casos y fotos ("¿esto se puede?"); las fotos no se guardan.

- **Cloudflare Pages (con IA):** <https://vaciolegalcsb.pages.dev>
- **GitHub Pages (copia):** <https://pedrocova13.github.io/vaciolegalcsb/>; su asistente usa la IA de Cloudflare.

## Cómo está hecho

| Archivo | Qué es |
|---|---|
| `docs/index.html` | La página completa. Los datos del reglamento van en el bloque `<script type="application/json" id="datos">`. |
| `functions/api/ia.js` | El asistente (`/api/ia`): Workers AI (Gemma 4, y Llama 4 Scout si falla), responde solo con esos datos. |
| `wrangler.toml` | Configura el proyecto de Pages: carpeta `docs` y la variable `AI`. |

La IA gratis de Cloudflare son 10.000 neuronas al día para toda la cuenta (también las usa Surf Maitencillo).
Esta guía se pone un tope de 1.500 neuronas al día y 20 preguntas por conexión; si se acaba, el asistente
responde buscando en el reglamento.

Esto es un análisis orientativo. Para acciones formales (recurso, demanda, amparo) consulta a un abogado.
