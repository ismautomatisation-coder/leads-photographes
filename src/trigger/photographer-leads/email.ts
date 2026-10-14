import type { Lead } from "./find-leads.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function websiteCell(website: string): string {
  if (!/^https?:\/\//i.test(website)) return escapeHtml(website);
  const url = escapeHtml(website);
  return `<a href="${url}">${url}</a>`;
}

export function buildSubject(week: number, cities: string[]): string {
  return `Leads photographes – semaine ${week} – ${cities.join(", ")}`;
}

export function buildEmailHtml(params: {
  week: number;
  cities: string[];
  leads: Lead[];
  target: number;
  failedCities: string[];
}): string {
  const { week, cities, leads, target, failedCities } = params;
  const hot = leads.filter((l) => l.score >= 4).length;

  const summary = [
    `Semaine ${week} — villes : <strong>${escapeHtml(cities.join(", "))}</strong>.`,
    `${leads.length} lead${leads.length > 1 ? "s" : ""} qualifié${leads.length > 1 ? "s" : ""}, dont <strong>${hot}</strong> avec un score de 4-5.`,
  ];
  if (leads.length < target) {
    summary.push(`Objectif de ${target} leads non atteint cette semaine.`);
  }
  if (failedCities.length > 0) {
    summary.push(`Recherche en échec pour : ${escapeHtml(failedCities.join(", "))}.`);
  }

  const th = `style="background:#f2f2f2;border:1px solid #ddd;padding:6px;text-align:left"`;
  const td = `style="border:1px solid #ddd;padding:6px;vertical-align:top"`;

  const rows = leads
    .map(
      (l) => `<tr>
  <td ${td}><strong>${escapeHtml(l.name)}</strong></td>
  <td ${td}>${escapeHtml(l.city)}</td>
  <td ${td}>${escapeHtml(l.specialty)}</td>
  <td ${td}>${websiteCell(l.website)}</td>
  <td ${td}>${escapeHtml(l.problem)}</td>
  <td ${td}>${escapeHtml(l.contact)}</td>
  <td ${td} align="center"><strong>${l.score}</strong></td>
  <td ${td}>${escapeHtml(l.angle)}</td>
</tr>`,
    )
    .join("\n");

  const dm = `Bonjour [Prénom] ! J'ai découvert ton travail de photographe à [ville] et j'adore [détail précis d'une photo]. En regardant ta présence en ligne, j'ai remarqué que [problème constaté] — c'est dommage, car beaucoup de clients cherchent un photographe directement sur Google avant de réserver. Je crée des sites pensés pour les photographes (galerie qui met en valeur tes images, tarifs, réservation en ligne). Ça te dirait que je te montre en 2 minutes à quoi pourrait ressembler le tien ?`;

  return `<!doctype html>
<html lang="fr"><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">
<h2>Leads photographes — semaine ${week}</h2>
<p>${summary.join("<br>")}</p>
<table style="border-collapse:collapse;width:100%;font-size:13px">
<thead><tr>
  <th ${th}>Nom / Studio</th><th ${th}>Ville</th><th ${th}>Spécialité</th><th ${th}>Site actuel</th>
  <th ${th}>Problème constaté</th><th ${th}>Contact</th><th ${th}>Score</th><th ${th}>Angle d'approche</th>
</tr></thead>
<tbody>
${rows || `<tr><td ${td} colspan="8">Aucun lead qualifié trouvé cette semaine.</td></tr>`}
</tbody>
</table>
<h3>Modèle de DM Instagram</h3>
<p style="background:#f7f7f7;padding:12px;border-left:3px solid #999">${escapeHtml(dm)}</p>
</body></html>`;
}
