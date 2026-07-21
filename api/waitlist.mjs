// Endpoint d'inscription à la liste d'attente.
// La clé Brevo vit ici, côté serveur — elle ne doit jamais partir dans le HTML.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Limite par IP, en mémoire de l'instance.
// Volontairement large : les réseaux mobiles partagent une même IP entre
// beaucoup d'abonnés, une limite trop basse bloquerait de vrais visiteurs.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();

  // Purge des entrées expirées — sinon la Map grossit sans fin sur une instance chaude.
  for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);

  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  if (rateLimited(ip)) {
    console.warn('[waitlist] limite atteinte pour', ip);
    return res.status(429).json({ error: 'rate_limited' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  const listId = Number(process.env.BREVO_LIST_ID);
  if (!apiKey || !Number.isInteger(listId)) {
    console.error('[waitlist] BREVO_API_KEY ou BREVO_LIST_ID absent des variables d\'environnement');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const { email, source } = req.body ?? {};
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const clean = email.trim().toLowerCase();

  const send = (withAttributes) =>
    fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        email: clean,
        listIds: [listId],
        updateEnabled: true, // réinscription d'un contact existant = mise à jour, pas une erreur
        ...(withAttributes
          ? { attributes: { SOURCE: typeof source === 'string' ? source.slice(0, 32) : 'inconnu' } }
          : {}),
      }),
    });

  try {
    let r = await send(true);
    if (r.ok) return res.status(200).json({ ok: true });

    let body = await r.json().catch(() => ({}));

    // L'attribut SOURCE n'existe pas dans ce compte Brevo : on réessaie sans.
    // L'inscription prime sur la donnée de provenance.
    if (r.status === 400 && /attribute/i.test(body.message || '')) {
      console.warn('[waitlist] attribut SOURCE absent — réessai sans attribut');
      r = await send(false);
      if (r.ok) return res.status(200).json({ ok: true });
      body = await r.json().catch(() => ({}));
    }

    if (body.code === 'duplicate_parameter') {
      // Déjà dans la liste : côté visiteur c'est un succès.
      return res.status(200).json({ ok: true, duplicate: true });
    }

    console.error('[waitlist] réponse Brevo', r.status, body);
    return res.status(502).json({ error: 'brevo_error' });
  } catch (e) {
    console.error('[waitlist] appel Brevo échoué', e);
    return res.status(502).json({ error: 'network_error' });
  }
}
