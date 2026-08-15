/**
 * Intermédiaire entre l'appli TOTO et Gemini.
 *
 * Pourquoi ce fichier existe : l'appli est un site public. Y écrire la clé
 * d'API la rendrait lisible par tous et facturable par n'importe qui. Ce
 * Worker garde la clé côté serveur ; l'appli ne lui envoie qu'une photo.
 *
 * À coller dans Cloudflare > Workers & Pages > Create > Worker.
 * Puis Settings > Variables : ajouter CLE_GEMINI (type Secret).
 */

// Seule ton appli peut appeler ce Worker. Sans cette liste, n'importe quel
// site pourrait s'en servir et consommer ton quota.
const ORIGINES_AUTORISEES = [
  "https://mtranbp-spec.github.io",
  "http://localhost:8080",
];

// Google retire régulièrement ses anciens modèles aux nouveaux comptes. On en
// essaie plusieurs dans l'ordre : le premier qui répond est utilisé. Ça évite
// de tomber en panne le jour d'une dépréciation.
const MODELES = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-2.5-flash"];

const CONSIGNE = `Tu analyses la photo d'une facture d'achat d'un commerce de Nouvelle-Calédonie.
Réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balises de code.

Champs attendus :
{
  "fournisseur": string,   // raison sociale de l'émetteur, pas du client (le client est TOTO)
  "date": string,          // date de la facture au format AAAA-MM-JJ, "" si illisible
  "numero": string,        // numéro de facture, "" si absent
  "ht": number,            // total hors taxe
  "tgc": number,           // montant total de la TGC (la TVA locale calédonienne)
  "ttc": number,           // total toutes taxes comprises
  "confiance": number      // 0 à 1, ta confiance dans cette lecture
}

Règles :
- Les montants sont en francs CFP, sans décimales le plus souvent. Renvoie des nombres, jamais de texte.
- Si un montant est illisible, mets 0 plutôt que d'inventer.
- Vérifie la cohérence : ht + tgc doit égaler ttc. Si ce n'est pas le cas, corrige le montant le moins lisible.
- N'inclus aucun commentaire ni explication.`;

function enTetes(origine) {
  return {
    "Access-Control-Allow-Origin": origine,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };
}

export default {
  async fetch(requete, env) {
    const origine = requete.headers.get("Origin") || "";
    const permise = ORIGINES_AUTORISEES.includes(origine) ? origine : ORIGINES_AUTORISEES[0];

    if (requete.method === "OPTIONS")
      return new Response(null, { headers: enTetes(permise) });

    if (requete.method !== "POST")
      return new Response(JSON.stringify({ erreur: "Méthode non autorisée" }), { status: 405, headers: enTetes(permise) });

    if (!ORIGINES_AUTORISEES.includes(origine))
      return new Response(JSON.stringify({ erreur: "Origine non autorisée" }), { status: 403, headers: enTetes(permise) });

    if (!env.CLE_GEMINI)
      return new Response(JSON.stringify({ erreur: "Clé absente : ajoute CLE_GEMINI dans les variables du Worker." }), { status: 500, headers: enTetes(permise) });

    let corps;
    try {
      corps = await requete.json();
    } catch (e) {
      return new Response(JSON.stringify({ erreur: "Requête illisible" }), { status: 400, headers: enTetes(permise) });
    }

    const image = String(corps.image || "");
    const mime = String(corps.mime || "image/jpeg");
    if (!image)
      return new Response(JSON.stringify({ erreur: "Aucune image reçue" }), { status: 400, headers: enTetes(permise) });

    // Garde-fou : une photo au-delà de ~6 Mo encodée est soit une erreur, soit
    // un envoi malveillant. On refuse plutôt que de la payer.
    if (image.length > 8_000_000)
      return new Response(JSON.stringify({ erreur: "Image trop lourde" }), { status: 413, headers: enTetes(permise) });

    const charge = JSON.stringify({
      contents: [{
        parts: [
          { text: CONSIGNE },
          { inline_data: { mime_type: mime, data: image } },
        ],
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    });

    let reponse = null, dernierDetail = "", modeleUtilise = "";
    for (const modele of MODELES) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent?key=${env.CLE_GEMINI}`;
      let r;
      try {
        r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: charge });
      } catch (e) {
        dernierDetail = "réseau : " + e.message;
        continue;
      }
      if (r.ok) {
        reponse = r;
        modeleUtilise = modele;
        break;
      }
      dernierDetail = (await r.text()).slice(0, 200);
      // 404 ou 400 : modèle inconnu ou retiré, on tente le suivant. Toute
      // autre erreur (quota, clé invalide) se répéterait à l'identique.
      if (r.status !== 404 && r.status !== 400)
        return new Response(JSON.stringify({ erreur: "Analyse refusée", statut: r.status, detail: dernierDetail }), { status: 502, headers: enTetes(permise) });
    }

    if (!reponse)
      return new Response(JSON.stringify({ erreur: "Aucun modèle disponible", detail: dernierDetail }), { status: 502, headers: enTetes(permise) });

    const donnees = await reponse.json();
    const texte = donnees?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let extrait;
    try {
      extrait = JSON.parse(texte);
    } catch (e) {
      // Le modèle a répondu hors format : on renvoie le texte brut pour
      // que l'appli puisse au moins l'afficher plutôt que d'échouer en silence.
      return new Response(JSON.stringify({ erreur: "Réponse inattendue", brut: texte.slice(0, 300) }), { status: 502, headers: enTetes(permise) });
    }

    const nombre = (v) => {
      const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
      return isNaN(n) ? 0 : Math.round(n * 100) / 100;
    };

    return new Response(JSON.stringify({
      fournisseur: String(extrait.fournisseur || "").slice(0, 80),
      date: String(extrait.date || ""),
      numero: String(extrait.numero || "").slice(0, 40),
      ht: nombre(extrait.ht),
      tgc: nombre(extrait.tgc),
      ttc: nombre(extrait.ttc),
      confiance: nombre(extrait.confiance),
      modele: modeleUtilise,
    }), { headers: enTetes(permise) });
  },
};
