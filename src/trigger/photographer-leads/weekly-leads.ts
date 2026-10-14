import { logger, schedules } from "@trigger.dev/sdk";
import { Redis } from "@upstash/redis";
import { Resend } from "resend";
import { buildEmailHtml, buildSubject } from "./email.js";
import { findLeadsForCity, type Lead } from "./find-leads.js";

const CITIES = [
  "Paris", "Lyon", "Marseille", "Toulouse", "Nice", "Nantes", "Montpellier", "Strasbourg",
  "Bordeaux", "Lille", "Rennes", "Reims", "Toulon", "Grenoble", "Dijon", "Angers", "Nîmes",
  "Clermont-Ferrand", "Le Mans", "Aix-en-Provence",
];
const CITIES_PER_WEEK = 3;
const TARGET_LEADS = 15;
const SENT_KEY = "photographer-leads:sent";

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

// Clé de déduplication : nom sans accents/ponctuation, ou domaine du site s'il existe
function leadKeys(lead: Lead): string[] {
  const keys = [
    "name:" + lead.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, ""),
  ];
  try {
    const host = new URL(lead.website).hostname.replace(/^www\./, "");
    keys.push("site:" + host);
  } catch {
    // pas de site (« aucun »)
  }
  return keys;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const weeklyPhotographerLeads = schedules.task({
  id: "photographer-leads-weekly",
  cron: {
    pattern: "0 9 * * 1", // chaque lundi à 9h
    timezone: "Europe/Paris",
    environments: ["PRODUCTION"],
  },
  run: async (payload) => {
    const resendKey = requireEnv("RESEND_API_KEY");
    const redisUrl = requireEnv("UPSTASH_REDIS_REST_URL");
    const redisToken = requireEnv("UPSTASH_REDIS_REST_TOKEN");
    const to = requireEnv("REPORT_TO_EMAIL");
    const from = requireEnv("REPORT_FROM_EMAIL");
    requireEnv("ANTHROPIC_API_KEY");

    const week = isoWeek(new Date(payload.timestamp));
    const start = (week * CITIES_PER_WEEK) % CITIES.length;
    const maxCities = Number(process.env.LEADS_MAX_CITIES) || CITIES_PER_WEEK;
    const cities = Array.from({ length: CITIES_PER_WEEK }, (_, i) => CITIES[(start + i) % CITIES.length])
      .slice(0, maxCities);
    logger.info("Villes de la semaine", { week, cities });

    const redis = new Redis({ url: redisUrl, token: redisToken });
    const sentKeys = new Set(await redis.smembers(SENT_KEY));
    const excludeNames = [...sentKeys]
      .filter((k) => k.startsWith("label:"))
      .map((k) => k.slice("label:".length));

    const collected: Lead[] = [];
    const failedCities: string[] = [];
    for (const city of cities) {
      const result = await findLeadsForCity.triggerAndWait({ city, excludeNames });
      if (result.ok) {
        collected.push(...result.output.leads);
      } else {
        logger.error("Recherche échouée", { city, error: result.error });
        failedCities.push(city);
      }
    }

    // Retire les doublons (entre villes et avec les semaines précédentes)
    const seen = new Set(sentKeys);
    const fresh: Lead[] = [];
    for (const lead of collected) {
      const keys = leadKeys(lead);
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      fresh.push(lead);
    }
    const leads = fresh.sort((a, b) => b.score - a.score).slice(0, TARGET_LEADS);

    const resend = new Resend(resendKey);
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject: buildSubject(week, cities),
      html: buildEmailHtml({ week, cities, leads, target: TARGET_LEADS, failedCities }),
    });
    if (error) throw new Error(`Envoi Resend échoué : ${error.message}`);
    logger.info("Email envoyé", { emailId: data?.id, count: leads.length });

    // Mémorise les leads seulement une fois l'email parti
    const toStore = leads.flatMap((l) => [...leadKeys(l), `label:${l.name} (${l.city})`]);
    if (toStore.length > 0) {
      const [first, ...rest] = toStore;
      await redis.sadd(SENT_KEY, first, ...rest);
    }

    return { week, cities, count: leads.length, failedCities };
  },
});
