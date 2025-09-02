import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn('GEMINI_API_KEY not set. Bot replies will fail.');
}

const genAI = new GoogleGenerativeAI(apiKey || '');
const model = () => genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Heurística de respaldo por si el modelo no devuelve JSON válido
function deriveEmotionFromText(text) {
  if (!text) return 'feliz';
  const t = String(text).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Emojis
  if (/[😂🤣😊🙂😁😄😍❤️✨🙌🎉]/u.test(t)) return 'feliz';
  if (/[😞😔😢😭😓😩😡💔]/u.test(t)) return 'triste';

  // Palabras clave (ajústalas a tu dominio)
  const positives = [
    'me alegra','felicidade','excelente','genial','maravilloso','que bien',
    'orgullo','lograste','me encanta','bravo','gracias'
  ];
  const negatives = [
    'lo siento','lamento','triste','dificil','complicado','preocup',
    'ansiedad','deprim','fracaso','mal','duro','duele'
  ];

  const posHit = positives.some(w => t.includes(w));
  const negHit = negatives.some(w => t.includes(w));

  if (posHit && !negHit) return 'feliz';
  if (negHit && !posHit) return 'triste';

  return 'feliz';
}

// Genera respuesta de Gemini. Devuelve { text, emotion, crisis }
export async function generateBotReply(messages) {
  // messages: [{author, content}]
  const history = messages.map(m => ({
    role: m.author === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  // Pedimos al modelo devolver SOLO JSON válido
  const systemGuidance = `
Actúa como un acompañante virtual de apoyo emocional y regulación de emociones.

Principios:
1. Tono: cálido, empático, cercano, profesional sin sonar clínico.
2. Objetivo: ayudar a que la persona se exprese, identifique y regule emociones; ofrecer psicoeducación ligera.
3. No juzgar ni minimizar. Usa validación emocional.
4. Fomenta autoconciencia con preguntas abiertas suaves.
5. Respuestas de 2–5 párrafos cortos como máximo.
6. No des consejos médicos ni diagnósticos. En riesgo, sugiere ayuda profesional/urgencias locales.
7. Promueve respiración consciente, grounding, journaling, pausas, contacto social saludable.

DEVUELVE ESTRICTAMENTE JSON VÁLIDO con esta forma:
{
  "answer": "texto al usuario (en español, sin markdown)",
  "emotion": "feliz" | "triste",
  "crisis": true | false
}

Reglas para "emotion":
- Usa "triste" si el contenido central del mensaje es de validación/acompañamiento ante dolor, frustración, pérdida, ansiedad o malestar predominante.
- Usa "feliz" cuando reconozcas avances, alivio, gratitud o tono mayormente esperanzador/positivo.
- Marca "crisis": true si detectas ideación o riesgo de suicidio/autolesión, violencia de pareja/familiar, abuso sexual, peligro inmediato o incapacidad de mantenerse a salvo ahora mismo. En duda, deja en false.
- No devuelvas otros campos ni comentarios fuera del JSON.
`;

  const generationConfig = {
    responseMimeType: 'application/json',
  };

  const result = await model().generateContent({
    contents: [
      { role: 'user', parts: [{ text: systemGuidance }] },
      ...history
    ],
    generationConfig
  });

  // Intentar parsear JSON
  let text = '';
  let emotion = 'feliz';
  let crisis = false;
  try {
    const raw = result.response.text(); // debería ser JSON puro
    const parsed = JSON.parse(raw);
    text = String(parsed?.answer || '').trim();
    const e = String(parsed?.emotion || '').toLowerCase();
    emotion = (e === 'feliz' || e === 'triste') ? e : deriveEmotionFromText(text);
    crisis = Boolean(parsed?.crisis);
  } catch {
    // Fallback si no vino JSON válido
    const fallback = result.response.text() || '';
    text = fallback.trim();
    emotion = deriveEmotionFromText(text);
  }

  // Devuelve listo para el frontend/API: { text, emotion, crisis }
  return { text, emotion, crisis };
}


