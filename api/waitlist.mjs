// Endpoint d'inscription à la liste d'attente.
// La clé Brevo vit ici, côté serveur — elle ne doit jamais partir dans le HTML.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Limite par IP, en mémoire de l'instance.
// Volontairement large : les réseaux mobiles partagent une même IP entre
// beaucoup d'abonnés, une limite trop basse bloquerait de vrais visiteurs.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const hits = new Map();

// Notification interne : un mail à chaque inscription pour être prévenu en temps réel.
// Volontairement « best effort » — si Brevo refuse l'envoi, l'inscription reste un succès.
// NOTIFY_TO   : destinataire de l'alerte (ta boîte).
// NOTIFY_FROM : expéditeur, DOIT être un expéditeur validé dans Brevo.
async function notify(apiKey, { email, source, ip, duplicate }) {
  const to = process.env.NOTIFY_TO;
  const from = process.env.NOTIFY_FROM;
  if (!to || !from) {
    // Notif non configurée : on ne bloque pas l'inscription, mais on le signale
    // pour ne pas rester aveugle si une variable manque en production.
    console.warn(
      '[waitlist] notif désactivée — NOTIFY_TO présent:', Boolean(to),
      '| NOTIFY_FROM présent:', Boolean(from),
    );
    return;
  }

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: from, name: 'Hybrid Club' },
        to: [{ email: to }],
        subject: duplicate
          ? `Réinscription liste d'attente : ${email}`
          : `Nouvelle inscription liste d'attente : ${email}`,
        textContent:
          `Email : ${email}\n` +
          `Provenance : ${source || 'inconnue'}\n` +
          `IP : ${ip}\n` +
          `Doublon : ${duplicate ? 'oui' : 'non'}\n` +
          `Date : ${new Date().toISOString()}`,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      console.error('[waitlist] notif email refusée', r.status, body);
    }
  } catch (e) {
    console.error('[waitlist] notif email échouée', e);
  }
}

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
    if (r.ok) {
      await notify(apiKey, { email: clean, source, ip, duplicate: false });
      return res.status(200).json({ ok: true });
    }

    let body = await r.json().catch(() => ({}));

    // L'attribut SOURCE n'existe pas dans ce compte Brevo : on réessaie sans.
    // L'inscription prime sur la donnée de provenance.
    if (r.status === 400 && /attribute/i.test(body.message || '')) {
      console.warn('[waitlist] attribut SOURCE absent — réessai sans attribut');
      r = await send(false);
      if (r.ok) {
        await notify(apiKey, { email: clean, source, ip, duplicate: false });
        return res.status(200).json({ ok: true });
      }
      body = await r.json().catch(() => ({}));
    }

    if (body.code === 'duplicate_parameter') {
      // Déjà dans la liste : côté visiteur c'est un succès.
      await notify(apiKey, { email: clean, source, ip, duplicate: true });
      return res.status(200).json({ ok: true, duplicate: true });
    }

    console.error('[waitlist] réponse Brevo', r.status, body);
    return res.status(502).json({ error: 'brevo_error' });
  } catch (e) {
    console.error('[waitlist] appel Brevo échoué', e);
    return res.status(502).json({ error: 'network_error' });
  }
}
