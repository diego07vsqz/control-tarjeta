/**
 * ══════════════════════════════════════════════════════════════════════════
 *  CHEQUEO DIARIO DE LÍMITE DE TARJETA
 * ──────────────────────────────────────────────────────────────────────────
 *  Corre desde GitHub Actions (ver .github/workflows/check-limite.yml).
 *  Lee la hoja "TARJETA" del mismo Google Sheet público que usa el dashboard,
 *  y si (gasto > límite personal) Y (faltan pocos días para el pago),
 *  envía un correo de alerta por Gmail SMTP. Guarda un pequeño estado en
 *  disco para no mandar el mismo aviso más de una vez por ciclo.
 *
 *  Variables de entorno requeridas (configuradas como GitHub Secrets):
 *    GMAIL_USER          — cuenta de Gmail que envía el correo
 *    GMAIL_APP_PASSWORD  — contraseña de aplicación (no la contraseña normal)
 *    ALERT_EMAIL_TO      — a qué correo se envía la alerta
 * ══════════════════════════════════════════════════════════════════════════
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// ── CONFIG ──────────────────────────────────────────────────────────────
const SHEET_ID = '1lTFi6NWYgzn_olV4usP4y2aWol_AnN096knpQ2rZ7Hk';
const SHEET_NAME = 'TARJETA';
const DAYS_BEFORE_ALERT = 3; // avisa cuando falten esta cantidad de días (o menos) para el pago
const STATE_PATH = path.join(__dirname, 'state', 'last-alert.json');

// ── PARSERS (mismos que usa el dashboard, para leer el Sheet igual) ───────
function parseDMY(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parseMoney(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function daysBetween(a, b) {
  const d1 = new Date(a + 'T00:00:00');
  const d2 = new Date(b + 'T00:00:00');
  return Math.round((d2 - d1) / 86400000);
}

// ── DATA LAYER ──────────────────────────────────────────────────────────
/**
 * Lee el Sheet público vía gviz. Columnas A–G:
 * FECHA | GASTOS | $ | Fecha de Corte | Fecha de Pago | Límite banco | Mi límite personal
 */
async function fetchSheet() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}&headers=1&_=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo leer el Sheet: HTTP ' + res.status);

  const text = await res.text();
  const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const rows = JSON.parse(jsonStr).table.rows || [];

  let total = 0;
  let pago = null;
  let limitePersonal = null;

  rows.forEach((row) => {
    const cells = row.c || [];
    const cell = (i) => (cells[i] ? (cells[i].f ?? cells[i].v ?? null) : null);

    const monto = parseMoney(cell(2));
    if (monto !== null) total += monto;

    if (!pago) pago = parseDMY(cell(4));
    if (!limitePersonal) limitePersonal = parseMoney(cell(6)); // columna G
  });

  return { total, pago, limitePersonal };
}

// ── PERSISTENCE (estado en disco, commiteado de vuelta al repo) ──────────
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    return { lastAlertedCycle: null };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// ── EMAIL ───────────────────────────────────────────────────────────────
async function sendAlertEmail({ total, limitePersonal, pago, daysLeft }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const vencido = daysLeft < 0;
  const asunto = vencido
    ? '🔴 Tarjeta: pago vencido y sigues sobre tu límite'
    : `⚠️ Tarjeta: pasaste tu límite y el pago vence en ${daysLeft} día${daysLeft === 1 ? '' : 's'}`;

  const html = `
    <div style="font-family:Arial,sans-serif;background:#14171f;color:#eef0f4;padding:28px;border-radius:14px;max-width:480px;margin:0 auto;">
      <h2 style="color:#e2536b;margin:0 0 14px;font-size:19px;">Alerta de tarjeta Cuscatlán</h2>
      <p style="line-height:1.6;margin:0 0 10px;">
        Llevas <b style="color:#fff;">$${total.toFixed(2)}</b> gastados este ciclo,
        por encima de tu límite personal de <b style="color:#fff;">$${limitePersonal.toFixed(2)}</b>.
      </p>
      <p style="line-height:1.6;margin:0 0 18px;">
        Fecha de pago: <b style="color:#fff;">${pago}</b>
        ${vencido ? '<span style="color:#e2536b;font-weight:700;"> (YA VENCIÓ)</span>' : `(en ${daysLeft} día${daysLeft === 1 ? '' : 's'})`}
      </p>
      <p style="color:#9aa1b0;font-size:12.5px;margin:0;">
        Correo generado automáticamente por tu dashboard de control de tarjeta.
      </p>
    </div>`;

  await transporter.sendMail({
    from: `"Control de Tarjeta" <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL_TO,
    subject: asunto,
    html,
  });
}

// ── MAIN ────────────────────────────────────────────────────────────────
(async () => {
  const { total, pago, limitePersonal } = await fetchSheet();

  if (!pago || !limitePersonal) {
    console.log('Faltan datos en el Sheet (fecha de pago o "Mi límite personal" en la columna G) — no se evalúa alerta.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const daysLeft = daysBetween(today, pago);
  const overLimit = total > limitePersonal;
  const closeToPayment = daysLeft <= DAYS_BEFORE_ALERT;

  console.log(`Gastado: $${total.toFixed(2)} · Límite: $${limitePersonal.toFixed(2)} · Pago: ${pago} · Días restantes: ${daysLeft}`);

  if (!(overLimit && closeToPayment)) {
    console.log('Sin condiciones de alerta. No se envía correo.');
    return;
  }

  const state = readState();
  const cycleKey = pago; // el ciclo se identifica por su fecha de pago

  if (state.lastAlertedCycle === cycleKey) {
    console.log('Ya se envió la alerta para este ciclo. No se repite.');
    return;
  }

  await sendAlertEmail({ total, limitePersonal, pago, daysLeft });
  writeState({ lastAlertedCycle: cycleKey, sentAt: new Date().toISOString() });
  console.log('✅ Alerta enviada a ' + process.env.ALERT_EMAIL_TO + ' y estado actualizado.');
})().catch((err) => {
  console.error('❌ Error en el chequeo:', err);
  process.exit(1);
});
