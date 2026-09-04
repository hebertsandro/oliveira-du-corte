const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("ERRO: a variável DATABASE_URL não foi configurada.");
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.error("ERRO: a variável ADMIN_PASSWORD não foi configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const SERVICES = [
  { id: "corte", name: "Corte", price: 30, duration: 30 },
  { id: "barba", name: "Barba", price: 30, duration: 30 },
  { id: "pezinho", name: "Pezinho", price: 10, duration: 10 },
  { id: "sobrancelha", name: "Sobrancelha", price: 10, duration: 10 }
  { id: "pigmentacao", name: "Pigmentação", price: 15, duration 15 }
];

// Horário provisório. Altere aqui quando o barbeiro passar os horários reais.
// 0 = domingo, 1 = segunda, ... 6 = sábado.
const BUSINESS_HOURS = {
  0: null,
  1: { open: "19:00", close: "22:00" },
  2: { open: "19:00", close: "22:00" },
  3: { open: "19:00", close: "22:00" },
  4: { open: "19:00", close: "22:00" },
  5: { open: "19:00", close: "22:00" },
  6: { open: "19:00", close: "22:00" }
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTimeString(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function dateParts(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function weekdayForDate(dateString) {
  const p = dateParts(dateString);
  if (!p) return null;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function minutesFromTime(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function timeFromMinutes(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function getService(serviceId) {
  return SERVICES.find(s => s.id === serviceId);
}

function isWithinBusinessHours(date, time, duration) {
  const weekday = weekdayForDate(date);
  const hours = BUSINESS_HOURS[weekday];
  if (!hours) return false;

  const start = minutesFromTime(time);
  const open = minutesFromTime(hours.open);
  const close = minutesFromTime(hours.close);
  return start >= open && start + duration <= close;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").slice(0, 15);
}

function adminAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id BIGSERIAL PRIMARY KEY,
      service_id VARCHAR(60) NOT NULL,
      service_name VARCHAR(120) NOT NULL,
      service_price NUMERIC(10,2) NOT NULL,
      duration_minutes INTEGER NOT NULL,
      appointment_date DATE NOT NULL,
      appointment_time TIME NOT NULL,
      customer_name VARCHAR(120) NOT NULL,
      customer_phone VARCHAR(30) NOT NULL,
      notes TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT appointments_status_check
        CHECK (status IN ('confirmed', 'completed', 'cancelled'))
    );

    CREATE INDEX IF NOT EXISTS appointments_date_idx
      ON appointments (appointment_date);

    CREATE INDEX IF NOT EXISTS appointments_status_idx
      ON appointments (status);
  `);
}

// Bloqueia sobreposição de horários no mesmo dia.
// É feito dentro de uma transação para reduzir risco de duas reservas simultâneas.
async function hasConflict(client, date, time, duration) {
  const result = await client.query(`
    SELECT id
    FROM appointments
    WHERE appointment_date = $1
      AND status <> 'cancelled'
      AND appointment_time < ($2::time + ($3::text || ' minutes')::interval)
      AND (appointment_time + (duration_minutes::text || ' minutes')::interval) > $2::time
    LIMIT 1
  `, [date, time, duration]);

  return result.rowCount > 0;
}

app.get("/api/services", (req, res) => {
  res.json(SERVICES);
});

app.get("/api/config", (req, res) => {
  res.json({
    businessHours: BUSINESS_HOURS
  });
});

app.get("/api/availability", async (req, res) => {
  try {
    const { date, serviceId } = req.query;
    const service = getService(serviceId);

    if (!isValidDateString(date) || !dateParts(date)) {
      return res.status(400).json({ error: "Data inválida." });
    }
    if (!service) {
      return res.status(400).json({ error: "Serviço inválido." });
    }

    const weekday = weekdayForDate(date);
    const hours = BUSINESS_HOURS[weekday];

    if (!hours) {
      return res.json({ date, service, slots: [] });
    }

    const result = await pool.query(`
      SELECT appointment_time, duration_minutes
      FROM appointments
      WHERE appointment_date = $1
        AND status <> 'cancelled'
      ORDER BY appointment_time
    `, [date]);

    const appointments = result.rows.map(row => ({
      start: minutesFromTime(String(row.appointment_time).slice(0, 5)),
      duration: Number(row.duration_minutes)
    }));

    const slots = [];
    const open = minutesFromTime(hours.open);
    const close = minutesFromTime(hours.close);

    // Slots de 15 em 15 minutos.
    for (let start = open; start + service.duration <= close; start += 15) {
      const end = start + service.duration;
      const occupied = appointments.some(a => {
        const aEnd = a.start + a.duration;
        return start < aEnd && end > a.start;
      });

      if (!occupied) {
        slots.push(timeFromMinutes(start));
      }
    }

    res.json({
      date,
      service,
      hours,
      slots
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível consultar os horários." });
  }
});

app.post("/api/appointments", async (req, res) => {
  const {
    serviceId,
    date,
    time,
    name,
    phone,
    notes
  } = req.body || {};

  const service = getService(serviceId);

  if (!service) {
    return res.status(400).json({ error: "Escolha um serviço válido." });
  }
  if (!isValidDateString(date) || !dateParts(date)) {
    return res.status(400).json({ error: "Escolha uma data válida." });
  }
  if (!isValidTimeString(time)) {
    return res.status(400).json({ error: "Escolha um horário válido." });
  }

  const customerName = String(name || "").trim();
  const customerPhone = normalizePhone(phone);
  const customerNotes = String(notes || "").trim().slice(0, 500);

  if (customerName.length < 2) {
    return res.status(400).json({ error: "Informe seu nome completo." });
  }
  if (customerPhone.length < 8) {
    return res.status(400).json({ error: "Informe um telefone válido." });
  }
  if (!isWithinBusinessHours(date, time, service.duration)) {
    return res.status(400).json({ error: "Esse horário está fora do funcionamento." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // O advisory lock usa a data como parte da chave e serializa reservas do mesmo dia.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`oliveira-du-corte:${date}`]
    );

    if (await hasConflict(client, date, time, service.duration)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Esse horário acabou de ser ocupado. Escolha outro horário."
      });
    }

    const result = await client.query(`
      INSERT INTO appointments (
        service_id,
        service_name,
        service_price,
        duration_minutes,
        appointment_date,
        appointment_time,
        customer_name,
        customer_phone,
        notes,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed')
      RETURNING
        id,
        service_name,
        service_price,
        duration_minutes,
        appointment_date,
        appointment_time,
        customer_name,
        customer_phone,
        notes,
        status
    `, [
      service.id,
      service.name,
      service.price,
      service.duration,
      date,
      time,
      customerName,
      customerPhone,
      customerNotes || null
    ]);

    await client.query("COMMIT");

    res.status(201).json({
      message: "Agendamento confirmado!",
      appointment: result.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Não foi possível salvar o agendamento." });
  } finally {
    client.release();
  }
});

app.get("/api/admin/appointments", adminAuth, async (req, res) => {
  try {
    const { date, status } = req.query;
    const params = [];
    const where = [];

    if (date) {
      if (!isValidDateString(date) || !dateParts(date)) {
        return res.status(400).json({ error: "Data inválida." });
      }
      params.push(date);
      where.push(`appointment_date = $${params.length}`);
    }

    if (status && ["confirmed", "completed", "cancelled"].includes(status)) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    const sql = `
      SELECT
        id,
        service_id,
        service_name,
        service_price,
        duration_minutes,
        TO_CHAR(appointment_date, 'YYYY-MM-DD') AS appointment_date,
        TO_CHAR(appointment_time, 'HH24:MI') AS appointment_time,
        customer_name,
        customer_phone,
        notes,
        status,
        created_at,
        updated_at
      FROM appointments
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY appointment_date ASC, appointment_time ASC
    `;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível carregar os agendamentos." });
  }
});

app.patch("/api/admin/appointments/:id/status", adminAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Agendamento inválido." });
  }
  if (!["confirmed", "completed", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Status inválido." });
  }

  try {
    const result = await pool.query(`
      UPDATE appointments
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, status
    `, [status, id]);

    if (!result.rowCount) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }

    res.json({
      message: "Status atualizado.",
      appointment: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível atualizar o status." });
  }
});

app.delete("/api/admin/appointments/:id", adminAuth, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Agendamento inválido." });
  }

  try {
    const result = await pool.query(
      "DELETE FROM appointments WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }

    res.json({ message: "Agendamento excluído." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível excluir o agendamento." });
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("*splat", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Rota não encontrada." });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Oliveira Du Corte rodando na porta ${PORT}`);
  });
}

start().catch(error => {
  console.error("Falha ao iniciar o servidor:", error);
  process.exit(1);
});