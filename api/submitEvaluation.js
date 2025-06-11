// submitEvaluation.js
// Vercel API with Cheerio HTML scraping, OpenAI threading, and timeouts/short-circuit for URL-only

import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { logTraffic } from "../logTraffic.js";

export const config = { api: { bodyParser: false } };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const promise = fetch(url, { ...opts, signal: controller.signal });
  promise.finally(() => clearTimeout(timer));
  return promise;
}

async function decodeVin(vin) {
  try {
    const res = await fetchWithTimeout(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`, {}, 5000);
    const data = await res.json();
    return { source: "NHTSA", data: data.Results[0] };
  } catch (err) {
    console.error("VIN decode failed:", err);
    return { source: "error", error: err.message };
  }
}

function extractRelevantURLs(text) {
  const urlRegex = /(https?:\/\/[\w.-]+\.(?!facebook)(copart|iaai|govdeals|bringatrailer|carsandbids|com|net|org)[^\s]*)/gi;
  return text?.match(urlRegex) || [];
}

async function fetchListingData(url) {
  try {
    const res = await fetchWithTimeout(url, {}, 5000);
    const html = await res.text();
    const $ = cheerio.load(html);
    return {
      url,
      title: $('title').text().trim(),
      price: $('[class*="price" i]').first().text().trim(),
      mileage: $('[class*="mileage" i], [class*="odometer" i]').first().text().trim(),
      condition: $('[class*="condition" i]').first().text().trim(),
    };
  } catch (err) {
    console.warn("Listing scrape failed:", err.message);
    return null;
  }
}

async function searchGoogle(query) {
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${process.env.GOOGLE_SEARCH_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}`;
  const res = await fetchWithTimeout(url, {}, 5000);
  return res.json();
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

    const { fields: rawFields, files } = await new Promise((resolve, reject) => {
      const form = formidable({ multiples: true, allowEmptyFiles: true, minFileSize: 0 });
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
    });

    const floppy = {};
    Object.entries(rawFields).forEach(([k, v]) => floppy[k] = Array.isArray(v) ? v[0] : v);

    const report = await runFullEvaluationLogic(floppy, files);
    await logTraffic({ endpoint: req.url, method: req.method, statusCode: 200, request: floppy, response: { report }, session_id: '', req });
    return res.status(200).json({ report });

  } catch (error) {
    console.error("❌ Handler error:", error);
    await logTraffic({ endpoint: req.url, method: req.method, statusCode: 500, request: {}, response: { error: error.message }, session_id: '', req });
    return res.status(500).json({ error: "Evaluation failed" });
  }
}

async function runFullEvaluationLogic(fields, files) {
  const { vin, role, repairSkill, zip, make, model, year, conditionNotes } = fields;

  let decodedData = {}, rawVinData = "";

  if (vin) {
    const vinResult = await decodeVin(vin);
    if (vinResult?.data) {
      decodedData = vinResult.data;
      rawVinData = JSON.stringify(vinResult.data, null, 2);
    }
  }

  const recallYear = year || decodedData.ModelYear || new Date().getFullYear();
  const recallMake = make || decodedData.Make || "";
  const recallModel = model || decodedData.Model || "";
  const recallURL = `https://askjasonauto-recalls.vercel.app/api/recalls?make=${encodeURIComponent(recallMake)}&model=${encodeURIComponent(recallModel)}&year=${recallYear}`;

  let recallData = null, retailData = {}, auctionData = {}, vinSearchData = {};
  try {
    const [rRes, retailRes, auctionRes, vinRes] = await Promise.all([
      fetchWithTimeout(recallURL, {}, 5000),
      searchGoogle(`${recallYear} ${recallMake} ${recallModel} value OR price OR common issues site:autotrader.com OR site:cargurus.com OR site:cars.com`),
      searchGoogle(`${recallYear} ${recallMake} ${recallModel} auction results OR sold prices site:copart.com OR site:iaai.com OR site:bringatrailer.com OR site:carsandbids.com`),
      vin ? searchGoogle(`VIN ${vin} site:copart.com OR site:iaai.com OR site:govdeals.com OR site:bid.cars OR site:autobidmaster.com`) : Promise.resolve({ items: [] })
    ]);
    if (!rRes.ok) throw new Error(`Recall API ${rRes.status}`);
    recallData = await rRes.json();
    retailData = retailRes;
    auctionData = auctionRes;
    vinSearchData = vinRes;
  } catch (e) {
    console.error("External search error:", e.message);
  }

      const recallBlock = recallData?.count > 0 ?
        `\n⚠️ Recall Alerts (${recallData.count}):\n${recallData.summaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n⚠️ List each recall above exactly as shown.` :
        'No recall alerts found.';

      function formatResults(title, data) {
        if (!data.items?.length) return `${title}\nNo results found.`;
        return title + "\n\n" +
          data.items.slice(0, 3).map((it, i) => `${i + 1}. **${it.title}**\n${it.snippet}\n🔗 ${it.link}`).join("\n\n");
      }

      let searchSummary = [
        "🌐 External Market Search:",
        formatResults("🏷️ Retail Pricing & Issues", retailData),
        formatResults("🏁 Auction Results", auctionData)
      ].join("\n\n");

      if (vinSearchData.items?.length) {
        searchSummary += "\n\n🔍 VIN-Specific Mentions:\n\n" + formatResults("Possible Auction History", vinSearchData);
      }

      // System prompt template
     const systemPrimer = [
"---",
  "- LANGUAGE + VOICE STYLE RULES:",
    "- You are Jason—speak like a seasoned streetwise car expert, not a chatbot.",
    "- Use blunt, confident language. Never hedge, waffle, or speculate.",
    "- Prioritize real-world deal logic over formal or technical language.",
    "- Sound like a coach giving sharp advice to someone in the game.",
    "- Favor short, punchy sentences over long explanations.",
    "- When you call out BS or red flags, do it clearly and boldly.",
    "- When giving cost logic or buyer plays, be tactical and assertive.",
    "- Use phrases like 'buyer beware,' 'run this deal,' 'this is where people lose money,' and 'fix this, skip that, sell fast.'",
    "- Do not speak passively or academically—this is street-smart evaluation.",
    "- Always end with a decisive call: 'Verdict: Walk / Talk / Run.'",
    "---",
    "You are Jason from Ask Jason Auto. The user is a ROLE_PLACEHOLDER with SKILL_PLACEHOLDER skill. This is a vehicle evaluation.",
    "- Follow this diagnostic-first flow:",
    "    1. Flag vehicle risk category based on mileage, recalls, model-year trends.",
    "    2. Treat known issues as potential until confirmed by notes, recall data, or VIN signals.",
    "    3. Use checklist to rule issues in or out. Do not assume repairs unless symptoms or trends suggest risk.",
    "    4. Perform money math only on confirmed issues.",
    "    5. Verdict comes last—after you’ve worked the logic.",
    "- You MUST return all 11 mandatory sections in order—no skipping or relabeling:",
    "    1. User Submission Recap",
    "    2. Evaluation Breakdown",
    "    3. Top 5 Known Issues + Repair Risk",
    "    4. Checklist (based on Role + Region)",
    "    5. Recall Risks",
    "    6. Jason’s Real Talk",
    "    7. Here’s How Jason Would Move",
    "    8. Money Math Table:",
    "        | Category             | As Listed | Worst Case |",
    "        |----------------------|-----------|------------|",
    "        | Asking Price         |           |            |",
    "        | Repairs              |           |            |",
    "        | Fees (TTL)           |           |            |",
    "        | All-In               |           |            |",
    "        | Max Price to Pay     |           |            |",
    "        | What Jason Saved You|           |            |",
    "    9. Verdict: Walk / Talk / Run",
    "    10. Internet Market Comps Summary",
    "    11. Internet Pricing Justification",
    "- NEVER include retail value or margin. Focus only on real cost math.",
    "- Max Price to Pay must never exceed asking price.",
    "- In buyer role, assume most sellers won’t go below 75% of asking price unless major issues are visible.",
    "---",
    "RECALL LOGIC:",
    "- Recalls are never a walk or run issue for a Buyer or Flipper.",
    "- Recalls are an opportunity—especially if the current symptom matches a known recall.",
    "- If issue matches a recall, flag it as a likely free fix and adjust cost math.",
    "- Say it clearly: 'This should be a $0 fix at the dealer. Use it.'",
    "- Do not double-count recall-related repairs in cost estimates.",
    "- If the seller hasn’t done the recall, that’s your leverage.",
    "- Recalls are deal ammo—not a scare tactic.",
    "- Highlight these opportunities in Jason’s Real Talk.",
    "- Do not require recall verification—just explain impact.",
    "- Show how recall alignment affects Max Price logic.",
    "---",
    "NO-NONSENSE LOGIC (ENFORCE IN ALL SECTIONS):",
    "- If seller says 'just needs a sensor' or similar, treat it as unverified. That’s code for 'buyer beware.'",
    "- Do not trust soft seller language or misleading direction on simple repairs needed—verify everything.",
    "- We do not suggest to buy anything with bad, missing, or rebuilt titles.",
    "- Curb-stoner risk? Flag it. Woods, gravel, mismatched phone numbers—call it.",
    "- No support for scams with fake photos or too-cheap-to-be-real listings.",
    "- We only support cash or verified bank check deals—no financing advice.",
    "- Jason does not support 'online vehicle shipping' unless source is verified (e.g. Carvana, Vroom, trusted broker).",
    "- Flag dealer lots that pretend to be private sellers.",
    "- If it smells like a flip scam, say it in Real Talk.",
    "---",
    "INTERNET INFORMATION SECTION RULES:",
    "- Always summarize market comps from search results. Give the user the details Jason would give them to be informed.",
    "- Give a price range for similar vehicles with similar mileage/recall status.",
    "- Use this range to justify your Max Pay recommendation.",
    "- Highlight if asking price is above or below the market average.",
    "- Mention any strong pricing anchors, major outliers, or patterns found online.",
    "---"
  ]
};
      // Assemble user prompt
      const userPrompt = [
        listingLinks.length ? `Listing: ${listingLinks[0]}` : "",
        `👤 Role: ${role}`,
        `🔧 Skill: ${repairSkill}`,
        `🚗 Year: ${recallYear}`,
        `🏷️ Make: ${recallMake}`,
        `📄 Model: ${recallModel}`,
        `📍 ZIP: ${zip}`,
        `📝 Notes: ${conditionNotes}`,
        rawVinData ? `🧾 VIN Data:\n${rawVinData}` : "",
        recallBlock,
        "🧠 Search Results:",
        searchSummary,
        ...systemPrimer.map(line =>
          line.replace("ROLE_PLACEHOLDER", role).replace("SKILL_PLACEHOLDER", repairSkill)
        )
      ].filter(Boolean).join("\n");

      // Send to OpenAI thread
      const thread = await openai.beta.threads.create();
      await openai.beta.threads.messages.create(thread.id, { role: "user", content: userPrompt });

      // Attach up to 2 photos
     if (files.photos) {
  const uploadFiles = Array.isArray(files.photos) ? files.photos : [files.photos];
  for (const photo of uploadFiles.slice(0, 2)) {
    if (photo && photo.size > 0 && photo.mimetype.startsWith("image/")) {
      try {
        let stream = fs.createReadStream(photo.filepath);
        let fileRec = await openai.files.create({ file: stream, purpose: "assistants" });

        await openai.beta.threads.messages.create(thread.id, {
          role: "user",
          content: `Describe what you see in this image:
- Identify the vehicle's make, model, year, and any visible trim or badging, from text or image
- Read any visible dash lights or messages
- Estimate mileage from the odometer if visible
- Call out red flags in the environment (e.g., gravel lot, wooded backdrop, non-residential building)
- Flag signs of flip behavior (e.g., over-detailed engine bay, out-of-state plate, missing VIN tags)
- Note any visible damage, wear, or evidence of recent quick-fix work
Add this image intelligence to the final evaluation.`,
        });

        await openai.beta.threads.messages.create(thread.id, {
          role: "user",
          content: `Evaluate this image for:
- Visible vehicle info (make, model, year, mileage, dash status)
- Dash warning lights (CEL, ABS, TPMS, airbag)
- Red flags: backdrop (woods, gravel, out-of-state tag), over-detailed engine bay, seller/dealer sketch cues
- Anything that affects resale, safety, or inspection urgency.
Include this in your full evaluation.`,
        });
      } catch (err) {
        console.error("Image processing failed:", err.message);
      }
    }
  }
}

      // Run & poll
      const run = await openai.beta.threads.runs.create(thread.id, { assistant_id: process.env.OPENAI_ASSISTANT_ID });
      let runStatus; const retryDelay = 1500; const timeoutLimit = 60000; const startTime = Date.now();
      do {
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        if (runStatus.status === "completed") break;
        if (runStatus.status === "failed") throw new Error("Assistant run failed");
        if (Date.now() - startTime > timeoutLimit) throw new Error("Timed out waiting for assistant");
        await new Promise(r => setTimeout(r, retryDelay));
      } while (true);

      const msgs = await openai.beta.threads.messages.list(thread.id);
      const assistantMsg = msgs.data.find(m => m.role === "assistant");
      const report = assistantMsg?.content?.[0]?.text?.value || "No report generated.";
      return report;
}
