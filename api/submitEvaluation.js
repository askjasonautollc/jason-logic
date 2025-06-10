// submitEvaluation.js
// Vercel API with Cheerio HTML scraping, OpenAI threading, and timeouts/short-circuit for link-only submissions

import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { logTraffic } from "../logTraffic.js";

// Disable body parsing for file uploads
export const config = { api: { bodyParser: false } };

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Utility: fetch with timeout to guard against slow endpoints
function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Decode VIN via NHTSA API
async function decodeVin(vin) {
  try {
    const res = await fetchWithTimeout(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`,
      {},
      5000
    );
    const data = await res.json();
    return { source: "NHTSA", data: data.Results[0] };
  } catch (err) {
    console.error("VIN decoder failed:", err);
    return { source: "error", error: err.message };
  }
}

// Extract relevant auction/listing URLs from notes
function extractRelevantURLs(text) {
  const urlRegex = /(https?:\/\/[\w.-]+\.(?!facebook)(copart|iaai|govdeals|bringatrailer|carsandbids|com|net|org)[^\s]*)/gi;
  return text?.match(urlRegex) || [];
}

// Scrape basic listing details via Cheerio
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
  } catch (e) {
    console.warn("Listing scrape failed:", e.message);
    return null;
  }
}

// Main handler
export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = formidable({ multiples: true, allowEmptyFiles: true, minFileSize: 0 });

  form.parse(req, async (err, fields, files) => {
    // Flatten fields
    const flatFields = {};
    Object.entries(fields).forEach(([key, value]) => {
      flatFields[key] = Array.isArray(value) ? value[0] : value;
    });
    const { conditionNotes = "", session_id, ...otherFields } = flatFields;

    if (err) {
      console.error("Form parse error:", err);
      await logTraffic({ endpoint: req.url, method: req.method, statusCode: 500, request: flatFields, response: { error: "Form parse error" }, session_id, req });
      return res.status(500).json({ error: "Form parse error" });
    }

    try {
      // SHORT-CIRCUIT: if only a single URL and no other user input, return that listing
      const listingLinks = extractRelevantURLs(conditionNotes);
      const nonNoteKeys = Object.keys(otherFields).filter(k => otherFields[k]);
      if (listingLinks.length === 1 && nonNoteKeys.length === 0) {
        const listing = await fetchListingData(listingLinks[0]);
        await logTraffic({ endpoint: req.url, method: req.method, statusCode: 200, request: flatFields, response: { listing }, session_id, req });
        return res.status(200).json({ listing });
      }

      // Full evaluation pipeline
      const { role, repairSkill, year, make, model, zip, vin, auctionSource } = flatFields;

      // VIN decode
      let decodedData = {};
      let rawVinData = "";
      if (vin) {
        const decoded = await decodeVin(vin);
        rawVinData = JSON.stringify(decoded.data, null, 2);
        decodedData = decoded.data || {};
      }

      // Recall lookup URL
      const recallYear = year || decodedData.ModelYear || decodedData.year || new Date().getFullYear();
      const recallMake = make || decodedData.Make || decodedData.make || "";
      const recallModel = model || decodedData.Model || decodedData.model || "";
      const recallURL = `https://askjasonauto-recalls.vercel.app/api/recalls?make=${encodeURIComponent(recallMake)}&model=${encodeURIComponent(recallModel)}&year=${recallYear}`;

      // Helper for Google Custom Search
      async function searchGoogle(query) {
        const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${process.env.GOOGLE_SEARCH_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}`;
        const resp = await fetchWithTimeout(url, {}, 5000);
        return resp.json();
      }

      // Parallel external calls
      let recallData = null, retailData = {}, auctionData = {}, vinData = {};
      try {
        const retailQuery = `${recallYear} ${recallMake} ${recallModel} value OR price OR common issues site:autotrader.com OR site:cargurus.com OR site:cars.com`;
        const auctionQuery = `${recallYear} ${recallMake} ${recallModel} auction results OR sold prices site:copart.com OR site:iaai.com OR site:bringatrailer.com OR site:carsandbids.com`;
        const vinQuery = vin ? `VIN ${vin} site:copart.com OR site:iaai.com OR site:govdeals.com OR site:bid.cars OR site:autobidmaster.com` : null;

        const [rRes, retail, auction, vinRes] = await Promise.all([
          fetchWithTimeout(recallURL, {}, 5000),
          searchGoogle(retailQuery),
          searchGoogle(auctionQuery),
          vinQuery ? searchGoogle(vinQuery) : Promise.resolve({ items: [] })
        ]);

        if (!rRes.ok) throw new Error(`Recall API ${rRes.status}`);
        recallData = await rRes.json();
        retailData = retail;
        auctionData = auction;
        vinData = vinRes;
      } catch (e) {
        console.error("Recall/search error:", e.message);
      }

      // Build recall block
      let recallBlock = 'No recall alerts found.';
      if (recallData?.count > 0 && Array.isArray(recallData.summaries)) {
        recallBlock = `\n⚠️ Recall Alerts (${recallData.count}):\n` + recallData.summaries.map((s,i) => `${i+1}. ${s}`).join('\n') +
          `\n\n⚠️ List each recall above exactly as shown.`;
      }

      // Format search results
      function formatResults(title, data) {
        if (!data.items?.length) return `${title}\nNo results found.`;
        return `${title}\n\n` + data.items.slice(0,3).map((it,i) =>
          `${i+1}. **${it.title}**\n${it.snippet}\n🔗 ${it.link}`
        ).join('\n\n');
      }
      let searchSummary = [
        "🌐 External Market Search:",
        formatResults("🏷️ Retail Pricing & Issues", retailData),
        formatResults("🏁 Auction Results", auctionData)
      ].join("\n\n");
      if (vin && vinData.items?.length) {
        searchSummary += "\n\n🔍 VIN-Specific Mentions:\n\n" + formatResults("Possible Auction History", vinData);
      }

      // System prompt
      const systemPrimer = [
        "---",
        `You are Jason from Ask Jason Auto. The user is a ROLE_PLACEHOLDER with SKILL_PLACEHOLDER skill. This is a vehicle evaluation. Use logic to fill in missing data. You MUST follow all system prompt rules from Ask Jason Auto.\`,
        ...[
          "- You MUST return all 11 mandatory sections in order—no skipping or relabeling:",
          "    1. User Submission Recap",
          "    2. Evaluation Breakdown",
          "    3. Top 5 Known Issues + Repair Risk",
          "    4. Checklist (based on Role + Region)",
          "    5. Recall Risks",
          "    6. Jason’s Real Talk",
          "    7. Here’s How Jason Would Move",
          "    8. Money Math Table (with resale value and net margin)",
          "    9. Internet Information",
          "   10. Verdict (✅ TALK / 🚪 WALK / ❌ RUN only)",
          "   11. Suggested Alternatives (only if WALK or RUN and user is Buyer or Flipper)",
          "- Use plain section headers '----------------------------'",
          "- NEVER use markdown headers or emojis in titles.",
          "---",
          "LOGIC BY ROLE (LOCKED)",
          "- BUYER: No resale talk. Focus on safe max price, traps, inspection risks.",
          "- FLIPPER: ROI-first logic. Include all costs (repairs, fees, title/tax, transport). Max Bid = (Resale ÷ 2) – Repairs – Fees.",
          "- SELLER: List-prep focus. Include 25% price buffer. Highlight title, receipts, photos.",
          "---",
          "REQUIRED LOGIC & OUTPUT RULES:",
          "- Always estimate mileage if missing (15k/year).",
          "- Always include a retail anchor price (search data or VIN).",
          "- Use retail data to estimate resale value.",
          "- ALWAYS define resale value as the pricing anchor—never use the current auction bid.",
          "- ALWAYS explain how 'Max Price to Pay' or 'Max Bid' is derived using resale minus repairs, fees, TTL, and margin buffer.",
          "- If actual auction bid exceeds calculated max bid, flag and explain.",
          "- Estimate and include buyer fees, TTL, transport.",
          "- Show plain-language math behind bid recommendation.",
          "- Checklist: 5–10 bullets by risk/value.",
          "- Adapt checklist to role, ZIP, auction platform.",
          "- If VIN/search shows auction listing, include a Yellow Flag for history.",
          "- Add 'Internet Market Summary' section.",
          "- Always return 'How Jason Would Move' with action language.",
          "- If verdict is WALK/RUN for Buyer/Flipper, recommend 3 alternates.",
          "- Use verdict language tone (e.g., 'You’ll eat this', 'Math is there').",
          "- NEVER skip Money Math: total cost, resale value, net margin.",
          "- Always end with one clear verdict: ✅ TALK / 🚪 WALK / ❌ RUN.",
          "- Be blunt, clean, organized—no fluff.",
          "---"
        ]
      ];

      // Build user prompt
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
        ...systemPrimer.map(line => line.replace("ROLE_PLACEHOLDER", role).replace("SKILL_PLACEHOLDER", repairSkill))
      ].filter(Boolean).join("\n");

      // Send to OpenAI
      const thread = await openai.beta.threads.create();
      await openai.beta.threads.messages.create(thread.id, { role: "user", content: userPrompt });

      // Attach up to 2 photos
      if (files.photos) {
        const uploads = Array.isArray(files.photos) ? files.photos : [files.photos];
        for (const photo of uploads.slice(0, 2)) {
          if (photo && photo.size > 0 && photo.mimetype.startsWith("image/")) {
            const stream = fs.createReadStream(photo.filepath);
            const fileRec = await openai.files.create({ file: stream, purpose: "assistants" });
            await openai.beta.threads.messages.create(thread.id, {
              role: "user",
              content: "Attached vehicle photo for review.",
              attachments: [{ file_id: fileRec.id, tools: [{ type: "code_interpreter" }] }]
            });
          }
        }
      }

      // Run the thread and poll for completion
      const run = await openai.beta.threads.runs.create(thread.id, { assistant_id: process.env.OPENAI_ASSISTANT_ID });
      let runStatus; let retries = 0; const retryDelay = 1500; const timeout = 60000; const start = Date.now();
      do {
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        if (runStatus.status === "completed") break;
        if (runStatus.status === "failed") throw new Error("Assistant run failed");
        if (Date.now() - start > timeout) throw new Error("Timed out waiting for assistant response");
        await new Promise(r => setTimeout(r, retryDelay));
      } while (true);

      const msgs = await openai.beta.threads.messages.list(thread.id);
      const assistantMsg = msgs.data.find(m => m.role === "assistant");
      const report = assistantMsg?.content?.[0]?.text?.value || "No report generated.";

      // Log and respond
      await logTraffic({ endpoint: req.url, method: req.method, statusCode: 200, request: flatFields, response: { report }, session_id, req });
      return res.status(200).json({ report });

    } catch (error) {
      console.error("❌ Evaluation error:", error);
      await logTraffic({ endpoint: req.url, method: req.method, statusCode: 500, request: flatFields, response: { error: error.message }, session_id, req });
      return res.status(500).json({ error: "Evaluation failed" });
    }
  });
}
