/**
 * محاكي Duffel Sandbox — خادم HTTP يتصرّف مثل api.duffel.com
 * الغرض: اختبار كود التكامل الحقيقي (نفس الترويسات والمسارات والحقول) بلا مفتاح.
 *
 * التشغيل:  npm run duffel:sim        (المنفذ 4555)
 * ثم:      DUFFEL_BASE_URL=http://127.0.0.1:4555 DUFFEL_API_KEY=test MARIA_MODE=live npm start
 *
 * ⚠️ هذا ليس Duffel: ردود مُصطنعة بالشكل الرسمي فقط.
 */
import http from 'node:http';

const ORDERS = new Map();   // idempotency-key → order
const PORT = Number(process.env.DUFFEL_SIM_PORT || 4555);
const EXPECTED_KEY = process.env.DUFFEL_SIM_KEY || 'test';

const OFFERS = [
  { seat: 'AH 6021', airline: 'Air Algérie', amount: '244.00', dur: 'PT3H05M', stops: 1 },
  { seat: 'TO 3301', airline: 'Transavia France', amount: '198.00', dur: 'PT3H10M', stops: 1 },
  { seat: 'AF 1455', airline: 'Air France', amount: '312.00', dur: 'PT3H00M', stops: 1 },
  { seat: 'LH 1319', airline: 'Lufthansa', amount: '226.00', dur: 'PT5H40M', stops: 2 },
];

const buildOffer = (o, i, origin, destination, date) => ({
  id: `off_sim_${i}_${Math.random().toString(36).slice(2, 9)}`,
  total_amount: o.amount,
  total_currency: 'USD',
  owner: { name: o.airline, iata_code: o.seat.split(' ')[0] },
  expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  slices: [{
    duration: o.dur,
    origin: { iata_code: origin },
    destination: { iata_code: destination },
    segments: Array.from({ length: o.stops }, (_, k) => ({
      origin: { iata_code: k === 0 ? origin : 'CDG' },
      destination: { iata_code: k === o.stops - 1 ? destination : 'CDG' },
      departing_at: `${date}T09:${(10 + k * 30).toString().padStart(2, '0')}:00`,
      arriving_at: `${date}T12:${(15 + k * 30).toString().padStart(2, '0')}:00`,
      marketing_carrier: { name: o.airline, iata_code: o.seat.split(' ')[0] },
    })),
  }],
});

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== EXPECTED_KEY) {
    return send(401, { errors: [{ title: 'Unauthorized', message: 'Invalid access token' }] });
  }
  if (req.headers['duffel-version'] !== 'v2') {
    return send(400, { errors: [{ title: 'Invalid version', message: 'Duffel-Version header required' }] });
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};

  if (req.method === 'POST' && req.url.startsWith('/air/offer_requests')) {
    const slice = body?.data?.slices?.[0] || {};
    const origin = slice.origin || 'ALG';
    const destination = slice.destination || 'CDG';
    const date = slice.departure_date || new Date().toISOString().slice(0, 10);
    console.log(`[sim] offer_request ${origin}→${destination} ${date} pax=${body?.data?.passengers?.length || 1}`);
    return send(201, {
      data: {
        id: 'orq_sim_' + Math.random().toString(36).slice(2, 10),
        live_mode: false,
        created_at: new Date().toISOString(),
        offers: OFFERS.map((o, i) => buildOffer(o, i, origin, destination, date)),
      },
    });
  }

  /* عرض محدّد */
  const offerM = req.method === 'GET' && req.url.match(/^\/air\/offers\/([^/?]+)/);
  if (offerM) {
    const o = buildOffer(OFFERS[0], 0, 'ALG', 'CDG', new Date().toISOString().slice(0, 10));
    console.log(`[sim] get offer ${offerM[1]}`);
    return send(200, { data: o });
  }

  /* طلب جديد — مع دعم Idempotency-Key */
  if (req.method === 'POST' && req.url.startsWith('/air/orders') && !req.url.includes('/actions/')) {
    const selected = body?.data?.selected_offers?.[0];
    const passengers = body?.data?.passengers || [];
    const idem = req.headers['idempotency-key'];
    if (!selected) return send(422, { errors: [{ code: 'validation_error', title: 'Invalid offer', message: 'selected_offers required' }] });
    if (!passengers.length) return send(422, { errors: [{ code: 'validation_error', title: 'Invalid passengers', message: 'passengers required' }] });
    if (selected.includes('expired')) return send(422, { errors: [{ code: 'offer_no_longer_available', title: 'Offer expired', message: 'offer expired' }] });

    /* نفس المفتاح ⇒ نفس الطلب (لا حجز مزدوج) */
    if (idem && ORDERS.has(idem)) {
      console.log(`[sim] idempotent replay ${idem} → ${ORDERS.get(idem).id}`);
      return send(200, { data: ORDERS.get(idem) });
    }

    const ref = 'SIM' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const order = {
      id: 'ord_sim_' + Math.random().toString(36).slice(2, 10),
      booking_reference: ref,
      status: 'confirmed',
      live_mode: false,
      total_amount: body?.data?.payments?.[0]?.amount || '0',
      total_currency: body?.data?.payments?.[0]?.currency || 'USD',
      passengers: passengers.map((p) => ({ id: 'pas_' + Math.random().toString(36).slice(2, 8), given_name: p.given_name })),
      documents: [{ type: 'electronic_ticket', unique_identifier: 'TKT-' + ref }],
      created_at: new Date().toISOString(),
    };
    if (idem) ORDERS.set(idem, order);
    console.log(`[sim] order created ${ref} offer=${selected} pax=${passengers.length} idem=${idem || '-'}`);
    return send(201, { data: order });
  }

  /* استرجاع طلب */
  const orderGet = req.method === 'GET' && req.url.match(/^\/air\/orders\/([^/?]+)$/);
  if (orderGet && !req.url.includes('/actions/')) {
    const found = [...ORDERS.values()].find(o => o.id === orderGet[1]);
    if (!found) return send(404, { errors: [{ code: 'not_found', title: 'Not found', message: 'order not found' }] });
    return send(200, { data: found });
  }

  /* إلغاء طلب */
  const cancelM = req.method === 'POST' && req.url.match(/^\/air\/orders\/([^/?]+)\/actions\/cancel/);
  if (cancelM) {
    const found = [...ORDERS.values()].find(o => o.id === cancelM[1]);
    if (!found) return send(404, { errors: [{ code: 'not_found', title: 'Not found', message: 'order not found' }] });
    found.status = 'cancelled';
    found.cancelled_at = new Date().toISOString();
    console.log(`[sim] order cancelled ${found.booking_reference}`);
    return send(201, {
      data: {
        id: found.id,
        status: 'cancelled',
        cancelled_at: found.cancelled_at,
        refund_amount: '199.00',
        refund_currency: found.total_currency,
        refund_to: 'balance',
      },
    });
  }

  return send(404, { errors: [{ title: 'Not found', message: req.url }] });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Duffel Sandbox Simulator — http://127.0.0.1:${PORT}`);
  console.log(`  مفتاح الاختبار: ${EXPECTED_KEY}`);
  console.log(`  استعمله بـ: DUFFEL_BASE_URL=http://127.0.0.1:${PORT} DUFFEL_API_KEY=${EXPECTED_KEY} MARIA_MODE=live\n`);
});
