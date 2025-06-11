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
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

    const { fields: rawFields, files } = await new Promise((resolve, reject) => {
      const form = formidable({ multiples: true, allowEmptyFiles: true, minFileSize: 0 });
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ fields, files }));
    });

    const floppy = {};
    Object.entries(rawFields).forEach(([k, v]) => floppy[k] = Array.isArray(v) ? v[0] : v);

    const report = await runFullEvaluationLogic(floppy, files);
    await logTraffic({
  endpoint: req.url,
  method: req.method,
  statusCode: 200,
  request: floppy,
  response: { report },
  session_id: '',
  user_agent: req.headers['user-agent'],
  ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress
});
    return res.status(200).json({ report });

  } catch (error) {
    console.error("❌ Handler error:", error);
    await logTraffic({
  endpoint: req.url,
  method: req.method,
  statusCode: 500,
  request: {}, // or `rawFields` if you want partial context
  response: { error: error.message },
  session_id: '',
  user_agent: req.headers['user-agent'],
  ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress
});
    return res.status(500).json({ error: "Evaluation failed" });
  }
}

// System prompt lines
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
"- You MUST return all 12 mandatory sections in order—no skipping or relabeling:",
"    1. User Submission Recap",
"    2. Evaluation Breakdown",
"    3. Top 5 Known Issues + Repair Risk",
"    4. Checklist (based on Role + Region)",
"    5. Recall Risks",
"    6. Image Intelligence",
"    7. Jason’s Real Talk",
"    8. Here’s How Jason Would Move",
"    9. Money Math Table:",
"        | Category             | As Listed | Worst Case |",
"        |----------------------|-----------|------------|",
"        | Asking Price         |           |            |",
"        | Repairs              |           |            |",
"        | Fees (TTL)           |           |            |",
"        | All-In               |           |            |",
"        | Max Price to Pay     |           |            |",
"        | What Jason Saved You|           |            |",
"    10. Verdict: Walk / Talk / Run",
"    11. Internet Market Comps Summary",
"    12. Internet Pricing Justification",
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
];

async function runFullEvaluationLogic(fields, files) {
  const { vin, role, repairSkill, zip, make, model, year, price, conditionNotes } = fields;
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

  const listingLinks = extractRelevantURLs(conditionNotes || "");
  const recallBlock = recallData?.count > 0 ? `\n⚠️ Recall Alerts (${recallData.count}):\n${recallData.summaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n⚠️ List each recall above exactly as shown.` : 'No recall alerts found.';

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

  const userPrompt = [
    listingLinks.length ? `Listing: ${listingLinks[0]}` : "",
    `👤 Role: ${role}`,
    `🔧 Skill: ${repairSkill}`,
    `🚗 Year: ${recallYear}`,
    `🏷️ Make: ${recallMake}`,
    `📄 Model: ${recallModel}`,
    `📍 ZIP: ${zip}`,
    `💰 Price: $${price}`,
    `📝 Notes: ${conditionNotes}`,
    rawVinData ? `🧾 VIN Data:\n${rawVinData}` : "",
    recallBlock,
    "🧠 Search Results:",
    searchSummary,
    ...systemPrimer.map(line => line.replace("ROLE_PLACEHOLDER", role).replace("SKILL_PLACEHOLDER", repairSkill))
  ].filter(Boolean).join("\n");
  
// BEGIN GPT EVALUATION FLOW
const thread = await openai.beta.threads.create();

// Step 1: Send primary evaluation prompt
await openai.beta.threads.messages.create(thread.id, {
  role: "user",
  content: userPrompt
});

// Step 2: Process and attach up to 2 images (if any)
const uploadFileIds = [];

if (files.photos) {
  const uploadFiles = Array.isArray(files.photos) ? files.photos : [files.photos];
  for (const photo of uploadFiles.slice(0, 2)) {
    if (photo && photo.size > 0 && photo.mimetype.startsWith("image/")) {
      try {
        const stream = fs.createReadStream(photo.filepath);
        const fileRec = await openai.files.create({
          file: stream,
          purpose: "assistants",
          name: photo.originalFilename || `photo-${Date.now()}.jpg`
        });
        uploadFileIds.push(fileRec.id);
      } catch (err) {
        console.error("Image upload failed:", err.message);
      }
    }
  }
}

if (uploadFileIds.length > 0) {
  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: `🖼️ IMAGE INTELLIGENCE SECTION:
Review the attached vehicle image(s) and generate a new report section labeled exactly:
**🖼️ Image Intelligence**

In that section, identify and summarize:
- Year, make, model, trim (if visible)
- Any visible body damage (especially front/rear impacts)
- Odd paint, panel gaps, missing parts, flipped plates
- Dash lights (CEL, ABS, TPMS, etc) if cluster is visible
- Interior damage, sloppy repairs, or missing components
- Context clues (woods, gravel lot, weird tags)

Do not blend this into other sections. Return it as a standalone section before 'Jason’s Real Talk'.`,
    attachments: uploadFileIds.map(id => ({
      file_id: id,
      tools: [{ type: "file_search" }]
    }))
  });
}

// Step 3: Run the GPT Assistant on the thread
const run = await openai.beta.threads.runs.create(thread.id, {
  assistant_id: process.env.OPENAI_ASSISTANT_ID
});

let runStatus;
const retryDelay = 1500;
const timeoutLimit = 60000;
const startTime = Date.now();

// Step 4: Poll until GPT finishes
do {
  runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
  if (runStatus.status === "completed") break;
  if (runStatus.status === "failed") throw new Error("Assistant run failed");
  if (Date.now() - startTime > timeoutLimit) throw new Error("Timed out waiting for assistant");
  await new Promise(r => setTimeout(r, retryDelay));
} while (true);

// Step 5: Extract final assistant response
const msgs = await openai.beta.threads.messages.list(thread.id);
const assistantMsg = msgs.data.find(m => m.role === "assistant");
const report = assistantMsg?.content?.[0]?.text?.value || "No report generated.";
// END GPT EVALUATION FLOW

if (["Buyer", "Flipper"].includes(fields.role)) {
  const asking = Number(fields.price) || 0;

  // Primary match: pull from Section 8
  const match = report.match(
    /Repairs\s*\|\s*\$([\d,]+)\s*\|\s*\$([\d,]+).*?Fees \(TTL\).*?\|\s*\$([\d,]+).*?Max Price to Pay.*?\$([\d,]+)/is
  );

  // Backup: Retail Value (from anywhere)
  const retailMatch = report.match(/Retail Value:?\s*\$([\d,]+)/i);
  const retailValue = retailMatch ? parseInt(retailMatch[1].replace(/,/g, "")) : null;

  if (match) {
    const [
      _,
      repairsLowRaw,
      repairsHighRaw,
      feesRaw,
      maxRaw
    ] = match;

    const repairsLow = parseInt(repairsLowRaw.replace(/,/g, ""));
    const repairsHigh = parseInt(repairsHighRaw.replace(/,/g, ""));
    const fees = parseInt(feesRaw.replace(/,/g, ""));
    const maxToPay = parseInt(maxRaw.replace(/,/g, ""));
    const savings = asking - maxToPay;
    const allInLow = asking + repairsLow + fees;
    const allInHigh = asking + repairsHigh + fees;

    const section8 = `
| Category             | As Listed | Worst Case |
|----------------------|-----------|------------|
${retailValue ? `| Retail Value         | $${retailValue.toLocaleString()} | $${retailValue.toLocaleString()} |` : ""}
| Asking Price         | $${asking.toLocaleString()} | $${asking.toLocaleString()} |
| Repairs              | $${repairsLow.toLocaleString()} | $${repairsHigh.toLocaleString()} |
| Fees (TTL)           | $${fees.toLocaleString()} | $${fees.toLocaleString()} |
| All-In               | $${allInLow.toLocaleString()} | $${allInHigh.toLocaleString()} |
| Max Price to Pay     | $${maxToPay.toLocaleString()} | $${maxToPay.toLocaleString()} |
| What Jason Saved You| $${savings.toLocaleString()} | $${savings.toLocaleString()} |
`;

    const updatedReport = report.replace(
      /8\. Money Math Table:[\s\S]*?(?=\n9\.)/,
      `8. Money Math Table:\n\n${section8.trim()}\n`
    );

    return updatedReport;
  }
}
  // Fallback if not Buyer/Flipper or regex match failed
return report;
}
