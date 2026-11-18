/**
 * طبقة الوصول للبيانات (SQL فقط) — تعمل على Postgres و PGlite بنفس الكود.
 * كل الدوال غير متزامنة (async) وتعيد صفوفًا جاهزة للاستخدام.
 */
import { db } from './index.js';

const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

/* ============================= الشركاء ============================= */
export async function listPartners() {
  const { rows } = await db().query(`SELECT * FROM partners ORDER BY created_at ASC`);
  return rows;
}
export async function getPartner(code) {
  if (!code) return null;
  const { rows } = await db().query(
    `SELECT * FROM partners WHERE upper(code) = upper($1) LIMIT 1`, [String(code)]
  );
  return rows[0] || null;
}
export async function getPartnerByApiKey(key) {
  if (!key) return null;
  const { rows } = await db().query(`SELECT * FROM partners WHERE api_key = $1 LIMIT 1`, [String(key)]);
  return rows[0] || null;
}
export async function createPartner(p) {
  const { rows } = await db().query(
    `INSERT INTO partners (code, name, type, email, phone, country, status, payout_method, api_key, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      p.code, p.name, p.type || 'agency', p.email || null, p.phone || null, p.country || null,
      p.status || 'active', J(p.payoutMethod || {}), p.apiKey || null,
      p.status === 'active' ? new Date().toISOString() : null,
    ]
  );
  return rows[0];
}
export async function setPartnerStatus(code, status) {
  const { rows } = await db().query(
    `UPDATE partners SET status = $2, approved_at = CASE WHEN $2 = 'active' THEN now() ELSE approved_at END
     WHERE upper(code) = upper($1) RETURNING *`,
    [String(code), status]
  );
  return rows[0] || null;
}

/* ============================= الحجوزات ============================= */
export async function createBooking(b) {
  const { rows } = await db().query(
    `INSERT INTO bookings (id, ref, vertical, offer, customer, pricing, status, provider_ref, timeline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [b.id, b.ref, b.vertical, J(b.offer), J(b.customer || {}), J(b.pricing), b.status || 'pending',
     b.providerRef || null, J(b.timeline || [])]
  );
  return rows[0];
}
export async function getBooking(id) {
  const { rows } = await db().query(`SELECT * FROM bookings WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] || null;
}
export async function listBookings({ partnerCode, status, vertical, limit = 200 } = {}) {
  const conds = [];
  const params = [];
  if (partnerCode) { params.push(String(partnerCode)); conds.push(`upper(ref) = upper($${params.length})`); }
  if (status) { params.push(status); conds.push(`status = $${params.length}`); }
  if (vertical) { params.push(vertical); conds.push(`vertical = $${params.length}`); }
  params.push(Math.min(Number(limit) || 200, 1000));
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const { rows } = await db().query(
    `SELECT * FROM bookings ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params
  );
  return rows;
}
export async function updateBooking(id, patch = {}) {
  const allowed = {
    status: 'status', provider_ref: 'providerRef', provider_status: 'providerStatus',
    handoff_url: 'handoffUrl', payment_id: 'paymentId', payout_id: 'payoutId', platform_payout_id: 'platformPayoutId', timeline: 'timeline',
  };
  const sets = [];
  const params = [];
  // patch قد يأتي بأسماء camelCase أو snake_case
  for (const [col, srcKey] of Object.entries(allowed)) {
    const v = patch[col] !== undefined ? patch[col] : patch[srcKey];
    if (v === undefined) continue;
    params.push(col === 'timeline' ? J(v) : v);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return getBooking(id);
  sets.push('updated_at = now()');
  params.push(id);
  const { rows } = await db().query(
    `UPDATE bookings SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params
  );
  return rows[0] || null;
}

/* ============================= دفتر القيود ============================= */
export async function addLedger(e) {
  const id = 'lg_' + Math.random().toString(36).slice(2, 10);
  const { rows } = await db().query(
    `INSERT INTO ledger_entries (id, booking_id, ref, type, status, amount, components, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, e.bookingId || null, e.ref || null, e.type, e.status, num(e.amount), J(e.components || {}), e.reason || null]
  );
  return rows[0];
}
export async function ledgerFor(bookingId) {
  const { rows } = await db().query(
    `SELECT * FROM ledger_entries WHERE booking_id = $1 ORDER BY at ASC`, [bookingId]
  );
  return rows;
}
export async function recentLedger(limit = 50) {
  const { rows } = await db().query(`SELECT * FROM ledger_entries ORDER BY at DESC LIMIT $1`, [limit]);
  return rows;
}

/* ============================= المدفوعات ============================= */
export async function createPayment(p) {
  const { rows } = await db().query(
    `INSERT INTO payments (id, booking_id, provider, provider_ref, amount, currency, status, method, three_ds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [p.id, p.bookingId, p.provider, p.providerRef || null, num(p.amount), p.currency || 'USD',
     p.status, p.method || 'card', Boolean(p.threeDs)]
  );
  return rows[0];
}
export async function getPayment(id) {
  const { rows } = await db().query(`SELECT * FROM payments WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] || null;
}
export async function getPaymentByBooking(bookingId) {
  const { rows } = await db().query(
    `SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`, [bookingId]
  );
  return rows[0] || null;
}
export async function updatePayment(id, patch = {}) {
  const sets = [];
  const params = [];
  for (const [col, key] of [['status', 'status'], ['provider_ref', 'providerRef'], ['failure_reason', 'failureReason']]) {
    const v = patch[col] !== undefined ? patch[col] : patch[key];
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return getPayment(id);
  sets.push('updated_at = now()');
  params.push(id);
  const { rows } = await db().query(
    `UPDATE payments SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params
  );
  return rows[0] || null;
}
export async function paymentsForBookings(ids = []) {
  if (!ids.length) return {};
  const { rows } = await db().query(
    `SELECT * FROM payments WHERE booking_id = ANY($1) ORDER BY created_at DESC`, [ids]
  );
  const map = {};
  for (const r of rows) if (!map[r.booking_id]) map[r.booking_id] = r;
  return map;
}
export async function getPaymentByProviderRef(ref) {
  const { rows } = await db().query(`SELECT * FROM payments WHERE provider_ref = $1 LIMIT 1`, [String(ref)]);
  return rows[0] || null;
}

/* ============================= حسابات التحصيل ============================= */
export async function upsertPayoutAccount(a) {
  const { rows } = await db().query(
    `INSERT INTO payout_accounts (id, owner_type, owner_code, method, holder_name, ccp_number, ccp_key, ccp_agency, bank_rib, foreign_wallet, currency, verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (owner_type, owner_code) DO UPDATE SET
       method = EXCLUDED.method, holder_name = EXCLUDED.holder_name,
       ccp_number = EXCLUDED.ccp_number, ccp_key = EXCLUDED.ccp_key, ccp_agency = EXCLUDED.ccp_agency,
       bank_rib = EXCLUDED.bank_rib, foreign_wallet = EXCLUDED.foreign_wallet,
       currency = EXCLUDED.currency, verified = EXCLUDED.verified, updated_at = now()
     RETURNING *`,
    [
      a.id || 'pa_' + Math.random().toString(36).slice(2, 10),
      a.ownerType, a.ownerCode, a.method || 'ccp', a.holderName,
      a.ccpNumber || null, a.ccpKey || null, a.ccpAgency || null,
      a.bankRib || null, a.foreignWallet || null, a.currency || 'DZD', Boolean(a.verified),
    ]
  );
  return rows[0];
}
export async function getPayoutAccount(ownerType, ownerCode) {
  const { rows } = await db().query(
    `SELECT * FROM payout_accounts WHERE owner_type = $1 AND owner_code = $2 LIMIT 1`, [ownerType, ownerCode]
  );
  return rows[0] || null;
}
export async function listPayoutAccounts() {
  const { rows } = await db().query(`SELECT * FROM payout_accounts ORDER BY owner_type, owner_code`);
  return rows;
}

/* ============================= التحويلات ============================= */
export async function addPayout(p) {
  const { rows } = await db().query(
    `INSERT INTO payouts (id, partner_code, partner_name, owner_type, amount, currency, items, status,
                         method, holder_name, destination, fx_rate, amount_dzd, reference, executed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      p.id, p.partnerCode, p.partnerName || null, p.ownerType || 'partner',
      num(p.amount), p.currency || 'USD', J(p.items || []), p.status || 'pending',
      p.method || 'ccp', p.holderName || null, p.destination || null,
      p.fxRate == null ? null : num(p.fxRate), p.amountDzd == null ? null : num(p.amountDzd),
      p.reference || null, p.executedAt || null,
    ]
  );
  return rows[0];
}
export async function getPayout(id) {
  const { rows } = await db().query(`SELECT * FROM payouts WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] || null;
}
export async function updatePayout(id, patch = {}) {
  const map = { status: 'status', reference: 'reference', executedAt: 'executed_at' };
  const sets = [], vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (!map[k] || v === undefined) continue;
    sets.push(`${map[k]} = $${i++}`);
    vals.push(v);
  }
  if (!sets.length) return getPayout(id);
  vals.push(id);
  const { rows } = await db().query(`UPDATE payouts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  return rows[0] || null;
}
export async function listPayouts(limit = 50, ownerType = null) {
  const { rows } = ownerType
    ? await db().query(`SELECT * FROM payouts WHERE owner_type = $2 ORDER BY created_at DESC LIMIT $1`, [limit, ownerType])
    : await db().query(`SELECT * FROM payouts ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}

/* ============================= Idempotency ============================= */
export async function getIdem(key) {
  if (!key) return null;
  const { rows } = await db().query(`SELECT * FROM idempotency WHERE key = $1 LIMIT 1`, [String(key)]);
  return rows[0] || null;
}
export async function setIdem(key, bookingId) {
  if (!key) return;
  await db().query(
    `INSERT INTO idempotency (key, booking_id) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET booking_id = EXCLUDED.booking_id`,
    [String(key), bookingId]
  );
}

/* ============================= Webhooks / Audit ============================= */
export async function addWebhook({ provider, type, verified, payload }) {
  const id = 'wh_' + Math.random().toString(36).slice(2, 10);
  const { rows } = await db().query(
    `INSERT INTO webhook_events (id, provider, type, verified, payload) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, provider, type || null, Boolean(verified), J(payload || {})]
  );
  return rows[0];
}
export async function addAudit(type, payload = {}) {
  await db().query(`INSERT INTO audit_events (type, payload) VALUES ($1,$2)`, [type, J(payload)]);
}

/* ============================= الفوترة ============================= */
export async function nextInvoiceSeq(year) {
  const { rows } = await db().query(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM invoices WHERE year = $1`, [year]);
  return Number(rows[0].n);
}
export async function addInvoice(inv) {
  const { rows } = await db().query(
    `INSERT INTO invoices (id, number, year, seq, booking_id, customer, seller, lines, subtotal, vat_amount, total, currency, total_dzd, fx_rate, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      inv.id, inv.number, inv.year, inv.seq, inv.bookingId, J(inv.customer || {}), J(inv.seller || {}),
      J(inv.lines || []), num(inv.subtotal), num(inv.vatAmount), num(inv.total),
      inv.currency || 'USD', inv.totalDzd == null ? null : num(inv.totalDzd),
      inv.fxRate == null ? null : num(inv.fxRate), inv.status || 'issued',
    ]
  );
  return rows[0];
}
export async function getInvoiceByBooking(bookingId) {
  const { rows } = await db().query(`SELECT * FROM invoices WHERE booking_id = $1 LIMIT 1`, [bookingId]);
  return rows[0] || null;
}
export async function getInvoiceByNumber(number) {
  const { rows } = await db().query(`SELECT * FROM invoices WHERE number = $1 LIMIT 1`, [String(number)]);
  return rows[0] || null;
}
export async function listInvoices(limit = 100) {
  const { rows } = await db().query(`SELECT * FROM invoices ORDER BY issued_at DESC LIMIT $1`, [limit]);
  return rows;
}

/* ============================= صندوق الرسائل ============================= */
export async function addOutbox(m) {
  const { rows } = await db().query(
    `INSERT INTO outbox (id, channel, to_addr, subject, template, html, text, booking_id, ref, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      m.id || 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      m.channel || 'email', m.to, m.subject, m.template || null,
      m.html || null, m.text || null, m.bookingId || null, m.ref || null, m.status || 'queued',
    ]
  );
  return rows[0];
}
export async function getOutbox(id) {
  const { rows } = await db().query(`SELECT * FROM outbox WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] || null;
}
export async function listOutbox(limit = 50, status = null) {
  const { rows } = status
    ? await db().query(`SELECT * FROM outbox WHERE status = $2 ORDER BY created_at DESC LIMIT $1`, [limit, status])
    : await db().query(`SELECT * FROM outbox ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}
export async function markOutbox(id, patch = {}) {
  const map = { status: 'status', provider: 'provider', providerRef: 'provider_ref', error: 'error', sentAt: 'sent_at' };
  const sets = [], vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (!map[k] || v === undefined) continue;
    sets.push(`${map[k]} = $${i++}`); vals.push(v);
  }
  sets.push(`attempts = attempts + 1`);
  vals.push(id);
  const { rows } = await db().query(`UPDATE outbox SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  return rows[0] || null;
}

/* ══════════════════ طلبات الحجز ══════════════════ */
const reqRow = (r) => r && ({
  ...r,
  offer: typeof r.offer === 'string' ? JSON.parse(r.offer) : r.offer,
  customer: typeof r.customer === 'string' ? JSON.parse(r.customer) : r.customer,
  passengers: typeof r.passengers === 'string' ? JSON.parse(r.passengers) : r.passengers,
  createdAt: r.created_at, decidedAt: r.decided_at, adminNote: r.admin_note,
  bookingId: r.booking_id, payUrl: r.pay_url,
});

export async function createRequest(rec) {
  const { rows } = await db().query(
    `INSERT INTO requests (id, code, vertical, offer, customer, note, passengers, status, ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [rec.id, rec.code, rec.vertical, JSON.stringify(rec.offer), JSON.stringify(rec.customer),
     rec.note || null, rec.passengers ? JSON.stringify(rec.passengers) : null, rec.status || 'new', rec.ref || null]);
  return reqRow(rows[0]);
}

export async function getRequest(id) {
  const { rows } = await db().query('SELECT * FROM requests WHERE id=$1 OR code=$1', [id]);
  return reqRow(rows[0]);
}

export async function listRequests({ status = null, limit = 100 } = {}) {
  const { rows } = status
    ? await db().query('SELECT * FROM requests WHERE status=$1 ORDER BY created_at DESC LIMIT $2', [status, limit])
    : await db().query('SELECT * FROM requests ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map(reqRow);
}

export async function updateRequest(id, patch) {
  const map = { status: 'status', adminNote: 'admin_note', bookingId: 'booking_id', payUrl: 'pay_url', decidedAt: 'decided_at' };
  const sets = [], vals = [];
  let i = 1;
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(patch[k]); }
  }
  if (!sets.length) return getRequest(id);
  vals.push(id);
  const n = vals.length;
  const { rows } = await db().query(
    `UPDATE requests SET ${sets.join(', ')} WHERE id=$${n} OR code=$${n} RETURNING *`, vals);
  return reqRow(rows[0]);
}

export async function countRequests() {
  const { rows } = await db().query(`SELECT status, COUNT(*)::int AS n FROM requests GROUP BY status`);
  return rows.reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
}
