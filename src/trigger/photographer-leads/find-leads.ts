import Anthropic from "@anthropic-ai/sdk";
import { schemaTask, logger } from "@trigger.dev/sdk";
import { z } from "zod";

export const leadSchema = z.object({
  name: z.string().min(1),
  city: z.string().min(1),
  specialty: z.string().min(1),
  website: z.string().min(1), // URL ou « aucun »
  problem: z.string().min(1),
  contact: z.string().min(1), // email, tél, Instagram — ou « non trouvé »
  score: z.number().int().min(1).max(5),
  angle: z.string().min(1),
});

export type Lead = z.infer<typeof leadSchema>;

const MODEL = "claude-sonnet-5-5";
const LEADS_PER_CITY = 5;
// Nombre maximal de reprises quand la recherche côté serveur se met en pause (pause_turn)
const MAX_CONTINUATIONS = 8;

function buildPrompt(city: string, excludeNames: string[]): string {
  const exclusions =
    excludeNames.length > 0
      ? `\n\nNe propose AUCUN de ces photographes/studios, ils ont déjà été envoyés :\n${excludeNames.map((n) => `- ${n}`).join("\n")}`
      : "";

  return `Tu es un assistant de prospection B2B. Je vends des sites web professionnels à des photographes (mariage, portrait, famille/naissance, corporate, immobilier, produit, événementiel) et studios photo en France.

Ta mission : trouver ${LEADS_PER_CITY} leads qualifiés à ${city}.

## Rechercher
Utilise la recherche web. Sources utiles : Google ("photographe mariage ${city}", "photographe portrait ${city}", etc.), Pages Jaunes, annuaires (mariages.net, zankyou), Instagram/Facebook pros, Google Maps, Malt, ComeUp. Varie les spécialités.

## Qualifier (le cœur de la mission)
Un lead est QUALIFIÉ s'il présente au moins un signal de besoin :
- Pas de site web du tout (seulement Instagram/Facebook/Pages Jaunes)
- Site obsolète (design daté, non responsive, Flash, lent, copyright ancien)
- Site sur sous-domaine gratuit (wixsite.com, jimdo, over-blog, wordpress.com, etc.) ou sans nom de domaine propre
- Site sans prix/formulaire de contact/réservation, ou sans galerie claire
- Mauvais référencement (n'apparaît pas sur sa ville + spécialité)
Ouvre réellement le site avec l'outil web_fetch pour vérifier. Exclus les photographes ayant déjà un site moderne et performant. Privilégie les indépendants actifs (posts récents, avis Google) — ils ont du budget et de la clientèle.
Attribue un score de 1 à 5 (5 = besoin évident + activité forte).

N'invente JAMAIS une info : si un email/téléphone n'est pas trouvé publiquement, écris « non trouvé ». Ne récupère que des coordonnées professionnelles publiées publiquement.${exclusions}

## Format de réponse
Termine ta réponse par UN bloc \`\`\`json contenant uniquement un tableau d'objets avec exactement ces champs :
- "name" : nom du photographe ou du studio
- "city" : "${city}"
- "specialty" : spécialité principale
- "website" : URL du site actuel, ou "aucun"
- "problem" : problème constaté sur sa présence en ligne (1 phrase)
- "contact" : email, téléphone, Instagram trouvés publiquement, ou "non trouvé"
- "score" : entier de 1 à 5
- "angle" : 1 phrase d'approche personnalisée à utiliser en DM/email

Si tu trouves moins de ${LEADS_PER_CITY} leads qualifiés, renvoie ceux que tu as (tableau vide si aucun).`;
}

function extractLeads(texts: string[]): Lead[] {
  const fullText = texts.join("\n");
  const blocks = [...fullText.matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = blocks.length > 0 ? blocks[blocks.length - 1][1] : fullText.match(/\[[\s\S]*\]/)?.[0];
  if (!raw) throw new Error("Aucun bloc JSON trouvé dans la réponse de Claude");
  return z.array(leadSchema).parse(JSON.parse(raw));
}

export const findLeadsForCity = schemaTask({
  id: "photographer-leads-find-city",
  schema: z.object({
    city: z.string(),
    excludeNames: z.array(z.string()),
  }),
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 60_000,
  },
  run: async ({ city, excludeNames }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    const client = new Anthropic({ apiKey });
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: buildPrompt(city, excludeNames) },
    ];
    const texts: string[] = [];
    const toolStats = { searches: 0, fetches: 0, errors: [] as string[] };

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      const response = await client.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium" },
          tools: [
            {
              type: "web_search_20260209",
              name: "web_search",
              max_uses: 15,
              user_location: { type: "approximate", country: "FR", city },
            },
            { type: "web_fetch_20260209", name: "web_fetch", max_uses: 15 },
          ],
          messages,
        })
        .finalMessage();

      for (const block of response.content) {
        if (block.type === "text") texts.push(block.text);
        // Les erreurs des outils web ne lèvent pas d'exception : elles arrivent dans le contenu
        if (block.type === "web_search_tool_result") {
          toolStats.searches++;
          if (!Array.isArray(block.content)) toolStats.errors.push(`web_search: ${block.content.error_code}`);
        }
        if (block.type === "web_fetch_tool_result") {
          toolStats.fetches++;
          if (block.content.type === "web_fetch_tool_result_error") {
            toolStats.errors.push(`web_fetch: ${block.content.error_code}`);
          }
        }
      }

      if (response.stop_reason === "pause_turn") {
        // Le serveur reprend tout seul à partir du dernier bloc server_tool_use
        logger.info("Recherche en pause, reprise", { city, attempt });
        messages.push({ role: "assistant", content: response.content });
        continue;
      }

      if (response.stop_reason === "refusal") {
        throw new Error(`Claude a refusé la requête pour ${city}`);
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error(`Réponse tronquée (max_tokens) pour ${city}`);
      }

      logger.info("Outils web", { city, ...toolStats });
      if (toolStats.searches === 0 || toolStats.errors.length === toolStats.searches + toolStats.fetches) {
        throw new Error(
          `Recherche web inutilisable pour ${city} (${toolStats.searches} recherches, erreurs : ${toolStats.errors.join(", ") || "aucune recherche lancée"}). Vérifie que web search / web fetch sont activés dans la console Anthropic.`,
        );
      }

      const leads = extractLeads(texts);
      logger.info("Leads trouvés", { city, count: leads.length, usage: response.usage });
      if (leads.length === 0) {
        logger.warn("Aucun lead — réponse de Claude", { city, text: texts.join("\n").slice(-3000) });
      }
      return { city, leads, toolStats, stopReason: response.stop_reason, tail: leads.length === 0 ? texts.join("\n").slice(-1500) : undefined };
    }

    throw new Error(`Trop de reprises (pause_turn) pour ${city}`);
  },
});
