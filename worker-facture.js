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
// Numéro de version renvoyé à chaque réponse : il suffit de le lire pour
// savoir quelle version tourne réellement sur Cloudflare.
const VERSION = "6-quota";

const MODELES = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-2.5-flash"];

const CONSIGNE = `Tu analyses la photo d'une facture d'achat d'un commerce de Nouvelle-Calédonie.
Réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balises de code.

Champs attendus :
{
  "fournisseur": string,   // raison sociale de l'émetteur, pas du client (le client est TOTO)
  "date": string,          // date de la facture au format AAAA-MM-JJ, "" si illisible
  "numero": string,        // numéro de facture, "" si absent
  "lignes": [              // UNE ENTRÉE PAR ARTICLE figurant sur la facture
    { "designation": string,
      "quantite": number,  // 1 si non précisée
      "pu": number,        // prix unitaire tel qu'imprimé, 0 si absent
      "taux": number,      // taux de TGC de cet article : 0, 3, 6, 11 ou 22
      "ttc": number,       // montant total TTC de la ligne
      "categorie": string }// une seule valeur parmi la liste ci-dessous
  ],
  "ventilation": [         // UNE ENTRÉE PAR TAUX DE TGC présent sur la facture
    { "taux": number,      // 0, 3, 6, 11 ou 22
      "ht": number,        // base hors taxe soumise à ce taux
      "tgc": number }      // montant de TGC pour ce taux
  ],
  "ht": number,            // total hors taxe, somme des bases
  "tgc": number,           // total de TGC, somme des lignes
  "ttc": number,           // total toutes taxes comprises
  "confiance": number      // 0 à 1, ta confiance dans cette lecture
}

Règles :
- Les montants sont en francs CFP, sans décimales le plus souvent. Renvoie des nombres, jamais de texte.
- La ventilation est le champ le plus important : une facture mélange souvent
  plusieurs taux (6 % sur l'alimentaire, 22 % sur les boissons sucrées). Cherche
  le tableau récapitulatif de TVA/TGC, généralement en bas de la facture, et
  rends une entrée par ligne de ce tableau.
- Si un seul taux apparaît, la ventilation contient une seule entrée.
- Pour les lignes d'articles : recopie la désignation telle qu'imprimée. Beaucoup
  de tickets marquent le taux par une lettre en fin de ligne (a, b, c...) dont la
  correspondance figure dans le tableau récapitulatif : traduis cette lettre en
  taux réel. Exemple : « 12 x 320,00 a » avec « a 11,00% » dans le tableau donne
  taux 11.
- Le montant de ligne imprimé sur un ticket de caisse est presque toujours TTC.
- Classe chaque article dans EXACTEMENT une de ces catégories comptables :
  "Boisson"          : sodas, eaux, jus, bières, sirops, boissons énergisantes
  "Matière première" : ingrédients entrant dans les plats — viande, poisson,
                       légumes, riz, farine, épices, huile, produits frais
  "Emballage"        : barquettes, sacs, couverts jetables, film, papier
  "Entretien"        : produits ménagers, éponges, gants, sacs poubelle
  "Matériel"         : équipement durable, ustensiles, mobilier, électroménager
  "Service"          : prestations, transport, abonnements, réparations
  "Autre"            : tout ce qui n'entre nulle part ailleurs
  Dans le doute entre matière première et autre chose, privilégie le rôle de
  l'article dans un commerce de plats à emporter.
- Si les articles ne sont pas lisibles, rends une liste vide plutôt que d'inventer.
- Si aucun tableau n'est lisible mais que tu as le HT et la TGC totaux, déduis
  le taux (tgc / ht × 100) et arrondis au taux légal le plus proche parmi 0, 3,
  6, 11, 22. Rends alors une entrée unique.
- Vérifie la cohérence : pour chaque entrée, tgc doit valoir environ ht × taux / 100.
  Et ht + tgc doit égaler ttc. Corrige le montant le moins lisible si besoin.
- Si un montant est illisible, mets 0 plutôt que d'inventer.
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

    // Un simple appel dans le navigateur affiche la version déployée.
    if (requete.method === "GET")
      return new Response(JSON.stringify({ version: VERSION, modeles: MODELES, cleConfiguree: !!env.CLE_GEMINI }), { headers: enTetes(permise) });

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
      // 429 : quota momentanément dépassé. On patiente puis on réessaie une
      // fois — un pic de quelques secondes ne doit pas faire échouer un lot.
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 6000));
        let r2;
        try {
          r2 = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: charge });
        } catch (e) {
          r2 = null;
        }
        if (r2 && r2.ok) {
          reponse = r2;
          modeleUtilise = modele;
          break;
        }
        return new Response(JSON.stringify({
          erreur: "Quota Gemini atteint",
          quota: true,
          conseil: "Le palier gratuit autorise 15 requêtes par minute et 1 500 par jour. Attends une minute, ou réduis la taille du lot.",
          statut: 429,
        }), { status: 429, headers: enTetes(permise) });
      }
      // 404 ou 400 : modèle inconnu ou retiré, on tente le suivant.
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

    const TAUX_LEGAUX = [0, 3, 6, 11, 22];
    const tauxProche = (v) => TAUX_LEGAUX.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), 0);

    // On assainit la ventilation : taux ramenés aux valeurs légales, entrées
    // vides écartées, et fusion des doublons éventuels.
    const brute = Array.isArray(extrait.ventilation) ? extrait.ventilation : [];
    const parTaux = new Map();
    brute.forEach((l) => {
      const t = tauxProche(nombre(l && l.taux));
      const ht = nombre(l && l.ht);
      const tgc = nombre(l && l.tgc);
      if (ht === 0 && tgc === 0) return;
      const e = parTaux.get(t) || { taux: t, ht: 0, tgc: 0 };
      e.ht += ht;
      e.tgc += tgc;
      parTaux.set(t, e);
    });
    let ventilation = Array.from(parTaux.values()).sort((a, b) => a.taux - b.taux);

    const htTotal = nombre(extrait.ht);
    const tgcTotal = nombre(extrait.tgc);
    // Repli : sans tableau lisible, on déduit un taux unique des totaux.
    if (!ventilation.length && htTotal > 0)
      ventilation = [{ taux: tauxProche((tgcTotal / htTotal) * 100), ht: htTotal, tgc: tgcTotal }];

    // Lignes d'articles : le montant imprimé est TTC, on en déduit HT et TGC
    // au taux de la ligne. Une ligne sans montant n'a pas d'intérêt.
    const lignes = (Array.isArray(extrait.lignes) ? extrait.lignes : [])
      .map((l) => {
        const taux = tauxProche(nombre(l && l.taux));
        const ttc = nombre(l && l.ttc);
        const ht = Math.round((ttc / (1 + taux / 100)) * 100) / 100;
        const cats = ["Boisson", "Matière première", "Emballage", "Entretien", "Matériel", "Service", "Autre"];
        const brutCat = String((l && l.categorie) || "").trim();
        const cat = cats.find((c) => c.toLowerCase() === brutCat.toLowerCase()) || "Autre";
        return {
          categorie: cat,
          designation: String((l && l.designation) || "").slice(0, 80),
          quantite: nombre(l && l.quantite) || 1,
          pu: nombre(l && l.pu),
          taux,
          ht,
          tgc: Math.round((ttc - ht) * 100) / 100,
          ttc,
        };
      })
      .filter((l) => l.designation && l.ttc > 0);

    const sommeHt = ventilation.reduce((s, l) => s + l.ht, 0);
    const sommeTgc = ventilation.reduce((s, l) => s + l.tgc, 0);

    return new Response(JSON.stringify({
      fournisseur: String(extrait.fournisseur || "").slice(0, 80),
      date: String(extrait.date || ""),
      numero: String(extrait.numero || "").slice(0, 40),
      lignes,
      ventilation,
      ht: htTotal || Math.round(sommeHt * 100) / 100,
      tgc: tgcTotal || Math.round(sommeTgc * 100) / 100,
      ttc: nombre(extrait.ttc) || Math.round((sommeHt + sommeTgc) * 100) / 100,
      confiance: nombre(extrait.confiance),
      modele: modeleUtilise,
      version: VERSION,
    }), { headers: enTetes(permise) });
  },
};
