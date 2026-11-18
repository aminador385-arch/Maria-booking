-- ماريا — مخطط قاعدة البيانات (Postgres)
-- يعمل على Postgres الحقيقي وعلى PGlite (نفس SQL)

CREATE TABLE IF NOT EXISTS partners (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'agency',
  email          TEXT,
  phone          TEXT,
  country        TEXT,
  status         TEXT NOT NULL DEFAULT 'active',      -- pending | active | suspended
  payout_method  JSONB DEFAULT '{}'::jsonb,
  api_key        TEXT UNIQUE,                          -- مفتاح بوابة الشريك
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,
  ref            TEXT NOT NULL REFERENCES partners(code),
  vertical       TEXT NOT NULL,
  offer          JSONB NOT NULL,
  customer       JSONB NOT NULL DEFAULT '{}'::jsonb,
  pricing        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',      -- pending|referred|confirmed|fulfilled|cancelled|refunded
  provider_ref   TEXT,
  provider_status TEXT,
  handoff_url    TEXT,
  payment_id     TEXT,
  payout_id      TEXT,
  timeline       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookings_ref ON bookings(ref);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at DESC);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             TEXT PRIMARY KEY,
  booking_id     TEXT,
  ref            TEXT,
  type           TEXT NOT NULL,                        -- accrual|settle|reversal|payout|refund
  status         TEXT NOT NULL,                        -- pending|earned|reversed|paid
  amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  components     JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason         TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_booking ON ledger_entries(booking_id);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entries(ref);

CREATE TABLE IF NOT EXISTS payments (
  id             TEXT PRIMARY KEY,
  booking_id     TEXT REFERENCES bookings(id),
  provider       TEXT NOT NULL,                        -- sandbox|stripe
  provider_ref   TEXT,
  amount         NUMERIC(12,2) NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  status         TEXT NOT NULL,                        -- requires_action|processing|succeeded|failed|refunded
  method         TEXT,                                 -- card|wallet|cib
  three_ds       BOOLEAN NOT NULL DEFAULT false,
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);

CREATE TABLE IF NOT EXISTS payouts (
  id             TEXT PRIMARY KEY,
  partner_code   TEXT NOT NULL,
  partner_name   TEXT,
  amount         NUMERIC(12,2) NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  items          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- الحجوزات المشمولة
  status         TEXT NOT NULL DEFAULT 'paid',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency (
  key            TEXT PRIMARY KEY,
  booking_id     TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  type           TEXT,
  verified       BOOLEAN NOT NULL DEFAULT false,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id             BIGSERIAL PRIMARY KEY,
  type           TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ══════════════ حسابات التحصيل (الحساب البريدي CCP / بنك / Payoneer) ══════════════
CREATE TABLE IF NOT EXISTS payout_accounts (
  id             TEXT PRIMARY KEY,
  owner_type     TEXT NOT NULL,                      -- platform | partner
  owner_code     TEXT NOT NULL,
  method         TEXT NOT NULL DEFAULT 'ccp',        -- ccp | bank | payoneer
  holder_name    TEXT NOT NULL,                      -- صاحب الحساب كما في الدفتر البريدي
  ccp_number     TEXT,                               -- 20 رقمًا (RIP)
  ccp_key        TEXT,                               -- مفتاح الحساب (رقمان)
  ccp_agency     TEXT,                               -- مكتب البريد
  bank_rib       TEXT,
  foreign_wallet TEXT,
  currency       TEXT NOT NULL DEFAULT 'DZD',
  verified       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_code)
);

-- أعمدة التحويل بالدينار + مرجع الحوالة (تُضاف بأمان لقواعد موجودة)
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS owner_type   TEXT NOT NULL DEFAULT 'partner';
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS method       TEXT NOT NULL DEFAULT 'ccp';
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS holder_name  TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS destination  TEXT;      -- رقم الحساب مقنّعًا
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS fx_rate      NUMERIC(12,4);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS amount_dzd   NUMERIC(14,2);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS reference    TEXT;      -- رقم الحوالة البريدي
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS executed_at  TIMESTAMPTZ;

-- تحويل المنصة منفصل عن تحويل الشريك (حجز واحد قد يحمل الاثنين)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_payout_id TEXT;

-- ══════════════════════ الفوترة (RC + NIF) ══════════════════════
CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  number         TEXT NOT NULL UNIQUE,                 -- MARIA-2026-000001
  year           INT NOT NULL,
  seq            INT NOT NULL,
  booking_id     TEXT NOT NULL REFERENCES bookings(id),
  customer       JSONB NOT NULL DEFAULT '{}'::jsonb,
  seller         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- لقطة الهوية القانونية وقت الإصدار
  lines          JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal       NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  total          NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'USD',
  total_dzd      NUMERIC(14,2),
  fx_rate        NUMERIC(12,4),
  status         TEXT NOT NULL DEFAULT 'issued',       -- issued | cancelled
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_year ON invoices(year, seq);

-- ═══════════════════════ صندوق الرسائل (Outbox) ═══════════════════════
CREATE TABLE IF NOT EXISTS outbox (
  id             TEXT PRIMARY KEY,
  channel        TEXT NOT NULL DEFAULT 'email',
  to_addr        TEXT NOT NULL,
  subject        TEXT NOT NULL,
  template       TEXT,
  html           TEXT,
  text           TEXT,
  booking_id     TEXT,
  ref            TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',   -- queued | sent | failed
  provider       TEXT,
  provider_ref   TEXT,
  error          TEXT,
  attempts       INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_booking ON outbox(booking_id);


-- ═══════════ طلبات الحجز (العميل يطلب، ونحن نؤكّد) ═══════════
CREATE TABLE IF NOT EXISTS requests (
  id           TEXT PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,
  vertical     TEXT NOT NULL,
  offer        JSONB NOT NULL,
  customer     JSONB NOT NULL,
  note         TEXT,
  passengers   JSONB,
  status       TEXT NOT NULL DEFAULT 'new',   -- new | approved | rejected | expired | cancelled
  admin_note   TEXT,
  booking_id   TEXT,
  pay_url      TEXT,
  ref          TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  decided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_code    ON requests (code);
