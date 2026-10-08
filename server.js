import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const defaultModel = process.env.OPENROUTER_MODEL || "openrouter/free";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const send = (status, body, type = "application/json; charset=utf-8") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
  };

  if (url.pathname === "/api/health") {
    return send(200, { ok: true, configured: Boolean(process.env.OPENROUTER_API_KEY), model: defaultModel });
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    if (!process.env.OPENROUTER_API_KEY) return send(503, { error: "На сервере не задан OPENROUTER_API_KEY." });
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 20000) req.destroy(); });
    req.on("end", async () => {
      try {
        const input = JSON.parse(body || "{}");
        const message = String(input.message || "").slice(0, 240);
        const history = Array.isArray(input.history) ? input.history.slice(-10) : [];
        const s = input.state || {};
        if (!message) return send(400, { error: "Пустой ответ игрока." });

        const system = `Ты NPC по прозвищу Гопник в комедийной браузерной игре «Пранк-Мастер». Ты грубоватый, непредсказуемый, уличный персонаж, но не карикатурный злодей. Отвечай живым разговорным русским, обычно 1-2 короткими фразами. Реагируй на смысл реплики и помни историю. Это вымышленная комедия, не давай инструкций по реальному насилию.
Текущее состояние: здоровье ${Number(s.health)||0}/100, уважение ${Number(s.respect)||0}/100, агрессия ${Number(s.aggression)||0}/100, ход ${Number(s.turn)||1} из 5. Если игрок промолчал, реагируй на неловкую паузу.
Верни только JSON с полями: npcLine (строка), healthDelta (целое от -35 до 0), respectDelta (целое от -15 до 20), aggressionDelta (целое от -20 до 30), end ("continue", "win" или "lose"), reason (строка), endingLine (строка).
Обычно продолжай разговор до пятого хода. Проигрыш только если агрессия достигнет 90 или здоровье упадёт до нуля. На пятом ходу при выживании end="win".`;

        const messages = [
          { role: "system", content: system },
          ...history.filter(m => m && ["user", "assistant"].includes(m.role)).map(m => ({ role: m.role, content: String(m.content || "").slice(0, 500) })),
          { role: "user", content: `Ответ игрока сейчас: ${message}\nВерни JSON с реакцией NPC и изменениями состояния.` }
        ];

        const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://prank-master.onrender.com",
            "X-Title": "Prank Master"
          },
          body: JSON.stringify({ model: defaultModel, messages, temperature: 0.9, max_tokens: 260 }),
          signal: AbortSignal.timeout(11000)
        });
        const raw = await upstream.text();
        if (!upstream.ok) return send(502, { error: `OpenRouter вернул ошибку ${upstream.status}: ${raw.slice(0, 250)}` });
        const payload = JSON.parse(raw);
        let content = payload?.choices?.[0]?.message?.content;
        if (Array.isArray(content)) content = content.map(x => x.text || "").join("");
        if (typeof content !== "string") return send(502, { error: "Модель не вернула текст." });
        content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        const start = content.indexOf("{"), end = content.lastIndexOf("}");
        if (start < 0 || end <= start) return send(502, { error: "Модель вернула ответ не в формате JSON." });
        const result = JSON.parse(content.slice(start, end + 1));
        const clamp = (v, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0));
        return send(200, {
          npcLine: String(result.npcLine || "Чё-то я не понял. Повтори.").slice(0, 400),
          healthDelta: clamp(result.healthDelta, -35, 0),
          respectDelta: clamp(result.respectDelta, -15, 20),
          aggressionDelta: clamp(result.aggressionDelta, -20, 30),
          end: ["continue", "win", "lose"].includes(result.end) ? result.end : "continue",
          reason: String(result.reason || "").slice(0, 300),
          endingLine: String(result.endingLine || "").slice(0, 300)
        });
      } catch (error) {
        return send(502, { error: `Ошибка ИИ: ${String(error?.message || error).slice(0, 180)}` });
      }
    });
    return;
  }

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(publicDir, requested);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== path.join(publicDir, "index.html")) return send(403, { error: "Forbidden" });
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
    send(200, data, types[ext] || "application/octet-stream");
  } catch {
    send(404, { error: "Not found" });
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Prank Master listening on ${port}`));