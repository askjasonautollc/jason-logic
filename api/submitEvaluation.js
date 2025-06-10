// Add at the top
import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { logTraffic } from "../logTraffic.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const decodeVin = async (vin) => {
  try {
    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`);
    const data = await res.json();
    return { source: "NHTSA", data: data.Results[0] };
  } catch (err) {
    console.error("VIN decoder (NHTSA) failed:", err);
    return { source: "error", error: err.message };
  }
};

const extractRelevantURLs = (text) => {
  const urlRegex = /(https?:\/\/[\w.-]+\.(?!facebook)(copart|iaai|govdeals|bringatrailer|carsandbids|com|net|org)[^\s]*)/gi;
  return text?.match(urlRegex) || [];
};

const fetchListingData = async (url) => {
  try {
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);

    const title = $('title').text().trim();
    const price = $('[class*="price" i]').first().text().trim();
    const mileage = $('[class*="mileage" i], [class*="odometer" i]').first().text().trim();
    const condition = $('[class*="condition" i]').first().text().trim();

    return { url, title, price, mileage, condition };
  } catch (e) {
    console.warn("Listing page scrape failed:", e.message);
    return null;
  }
};


export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const form = formidable({ multiples: true, allowEmptyFiles: true, minFileSize: 0 });

  form.parse(req, async (err, fields, files) => {
    const flatFields = {};
    for (const [key, val] of Object.entries(fields)) {
      flatFields[key] = Array.isArray(val) ? val[0] : val;
    }

    if (err) {
      console.error("❌ Form parse error:", err);
      await logTraffic({ endpoint: req.url, method: req.method, statusCode: 500, request: {}, response: { error: "Form parse error" }, req });
      return res.status(500).json({ error: "Form parse error" });
    }

    try {
      const assistantId = process.env.OPENAI_ASSISTANT_ID;
      const { role, repairSkill, year, make, model, zip, conditionNotes, vin, auctionSource } = flatFields;

      let decodedData = {};
      let rawVinData = "";
      if (vin) {
        const decoded = await decodeVin(vin);
        rawVinData = JSON.stringify(decoded.data, null, 2);
        decodedData = decoded.data || {};
      }

      const recallYear = year || decodedData.ModelYear || decodedData.year || new Date().getFullYear();
      const recallMake = make || decodedData.Make || decodedData.make || "";
      const recallModel = model || decodedData.Model || decodedData.model || "";

      const listingLinks = extractRelevantURLs(conditionNotes);
      let listingDetailBlock = "";
      if (listingLinks.length > 0) {
        const listingData = await fetchListingData(listingLinks[0]);
        if (listingData) {
          listingDetailBlock = [
            "📄 External Listing Details:",
            `🔗 URL: ${listingData.url}`,
            `📝 Title: ${listingData.title || "Not found"}`,
            `💰 Price: ${listingData.price || "Not found"}`,
            `📍 Mileage: ${listingData.mileage || "Not found"}`,
            `📋 Condition: ${listingData.condition || "Not found"}`,
            "---"
          ].join('\n');
        }
      }

      const recallURL = `https://askjasonauto-recalls.vercel.app/api/recalls?make=${encodeURIComponent(recallMake)}&model=${encodeURIComponent(recallModel)}&year=${recallYear}`;

      const retailQuery = `${recallYear} ${recallMake} ${recallModel} value OR price OR common issues site:autotrader.com OR site:cargurus.com OR site:cars.com`;
      const auctionQuery = `${recallYear} ${recallMake} ${recallModel} auction results OR sold prices site:copart.com OR site:iaai.com OR site:bringatrailer.com OR site:carsandbids.com`;
      const vinQuery = vin
        ? `VIN ${vin} site:copart.com OR site:iaai.com OR site:govdeals.com OR site:bid.cars OR site:autobidmaster.com`
        : null;

      const searchGoogle = async (query) => {
        const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${process.env.GOOGLE_SEARCH_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}`;
        const res = await fetch(url);
        return await res.json();
      };

      let recallData = null, retailData, auctionData, vinData;

      try {
        const [recallRes, retail, auction, vinResults] = await Promise.all([
          fetch(recallURL),
          searchGoogle(retailQuery),
          searchGoogle(auctionQuery),
          vinQuery ? searchGoogle(vinQuery) : Promise.resolve({ items: [] })
        ]);

        if (!recallRes.ok) throw new Error(`Recall API responded with ${recallRes.status}`);
        recallData = await recallRes.json();
        retailData = retail;
        auctionData = auction;
        vinData = vinResults;
      } catch (err) {
        console.error("❌ Recall or Search Enrichment failed:", err.message);
      }

      let recallBlock = 'No recall alerts found.';
      if (recallData?.count > 0 && Array.isArray(recallData.summaries)) {
        recallBlock = `\n⚠️ Recall Alerts (${recallData.count}):\n` +
          recallData.summaries.map((s, i) => `${i + 1}. ${s}`).join('\n') +
          `\n\n⚠️ List each recall above exactly as shown—1 bullet per recall. Do not summarize, skip, or rewrite.`;
      }

      const formatResults = (title, data) => {
        if (!data.items?.length) return `${title}\nNo results found.`;
        return `${title}\n\n` + data.items.slice(0, 3).map((item, i) =>
          `${i + 1}. **${item.title}**\n${item.snippet}\n🔗 ${item.link}`
        ).join('\n\n');
      };

      let searchSummary = [
        "🌐 External Market Search:",
        formatResults("🏷️ Retail Pricing & Issues", retailData),
        formatResults("🏁 Auction Results", auctionData)
      ].join('\n\n');

      if (vin && vinData.items?.length) {
        searchSummary += "\n\n🔍 VIN-Specific Mentions:\n\n" +
          formatResults("Possible Auction History", vinData);
      }
   const systemPrimer = [
  "",
  "---",
  `You are Jason from Ask Jason Auto. The user is a ROLE_PLACEHOLDER with SKILL_PLACEHOLDER skill. This is a vehicle evaluation. Use logic to fill in missing data. You MUST follow all system prompt rules from Ask Jason Auto.`,
  "- You MUST return all 11 mandatory sections in order—no skipping, no relabeling:",
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
  "- Use plain section headers with '----------------------------'",
  "- NEVER use markdown headers or emojis in section titles.",
  "",
  "---",
  "LOGIC BY ROLE (LOCKED)",
  "- You must enforce role-specific logic strictly—never mix logic between Buyer, Flipper, Seller.",
  "- BUYER: No resale talk. Focus on safe max price, traps, inspection risks.",
  "- FLIPPER: ROI-first logic. Include all costs (repairs, fees, title/tax, transport). Max Bid = (Resale ÷ 2) – Repairs – Fees.",
  "- SELLER: List-prep focus. Include 25% price buffer. Highlight title, receipts, photos.",
  "",
  "---",
  "REQUIRED LOGIC & OUTPUT RULES:",
  "- Always estimate mileage if missing (15k/year).",
  "- Always include a retail anchor price (search data or VIN).",
  "- Use retail data to estimate resale value.",
  "- ALWAYS define resale value as the pricing anchor—never use the current auction bid.",
  "- ALWAYS explain how 'Max Price to Pay' or 'Max Bid' is derived using resale minus repairs, fees, TTL, and risk/margin buffer.",
  "- If actual auction bid exceeds calculated max bid, flag this in the report and explain: 'Current bid is higher than our safe max—this deal no longer makes sense.'",
  "- Always estimate and include auction buyer fees, TTL (tax, title, license), and transport if relevant.",
  "- Show plain-language math behind your bid recommendation.",
  "- Checklist must include 5–10 bullets sorted by risk/value.",
  "- Checklist must adapt to user role, ZIP, and auction platform.",
  "- If VIN or search shows auction listing (past or current), include:",
  "   ⚠️ Yellow Flag: Auction History — explain title risk, undisclosed damage, or salvage possibility.",
  "- Add a 'Internet Market Summary' section summarizing top 3 comps, pricing flags, or issues.",
  "- Always return a 'How Jason Would Move' section with blunt, action-driven language.",
  "- If verdict is WALK or RUN and user is Buyer/Flipper, recommend 3 alternate vehicles with short value notes.",
  "- Use verdict language and phrase bank tone (e.g., 'You’ll eat this', 'Math is there', 'Flip trash').",
  "- NEVER skip Money Math. Must include: total cost, resale value (if role allows), net margin.",
  "- Always end with one clear verdict: ✅ TALK / 🚪 WALK / ❌ RUN.",
  "- Be blunt, clean, and organized—no fluff or hesitation.",
  "- Use '---' to divide sections. No markdown headers allowed."
];
        const userInput = [   
  listingDetailBlock,
  `👤 Role: ${role}`,
  `🔧 Repair Skill: ${repairSkill}`,
  `🚗 Year: ${recallYear}`,
  `🏷️ Make: ${recallMake}`,
  `📄 Model: ${recallModel}`,
  `📍 ZIP Code: ${zip}`,
  `📝 Notes: ${conditionNotes?.trim() ? conditionNotes : "Not specified by user"}`,
  `🔍 VIN: ${vin || "Not provided"}`,
  `🪙 Auction Source: ${auctionSource || "Not specified"}`,
  "",
  "🧾 Raw VIN Data:",
  rawVinData || "No decoded VIN data available.",
  "",
  recallBlock,
  "",
  "🧠 External Search Results:",
  searchSummary,
  ...systemPrimer.map(line =>
    line.replace("ROLE_PLACEHOLDER", role).replace("SKILL_PLACEHOLDER", repairSkill)
  )
].join('\n').trim();
      console.log("📩 userInput preview:", userInput);

      const thread = await openai.beta.threads.create();
      await openai.beta.threads.messages.create(thread.id, { role: "user", content: userInput });

      if (files.photos) {
        let uploads = Array.isArray(files.photos) ? files.photos : [files.photos];
        uploads = uploads.slice(0, 2).filter(file => file && file.size > 0 && file.mimetype?.startsWith("image/"));

        for (const photo of uploads) {
          const fileStream = fs.createReadStream(photo.filepath);
          const uploadedFile = await openai.files.create({ file: fileStream, purpose: "assistants" });

          await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: "Attached vehicle photo for review.",
            attachments: [{ file_id: uploadedFile.id, tools: [{ type: "code_interpreter" }] }],
          });
        }
      }

      const run = await openai.beta.threads.runs.create(thread.id, { assistant_id: assistantId });

      let runStatus, retries = 0;
      const retryDelay = 1500;
      const timeoutLimit = 60000;
      const runStart = Date.now();

      do {
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        const now = Date.now();
        console.log(`⏳ Run status: ${runStatus.status} (${now - runStart}ms elapsed)`);

        if (runStatus.status === "completed") break;
        if (runStatus.status === "failed") throw new Error("Assistant run failed");
        if ((now - runStart) > timeoutLimit) throw new Error("Timed out waiting for assistant response");

        retries++;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } while (true);

      const messages = await openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data.find(msg => msg.role === "assistant");
      const markdown = lastMessage?.content?.[0]?.text?.value || "No report generated.";

      await logTraffic({ endpoint: req.url, method: req.method, statusCode: 200, request: flatFields, response: { report: markdown }, session_id: flatFields.session_id, req });
      return res.status(200).json({ report: markdown });

    } catch (e) {
      console.error("❌ Evaluation error:", e);
      await logTraffic({ endpoint: req.url, method: req.method, statusCode: 500, request: flatFields, response: { error: e.message }, session_id: flatFields.session_id, req });
      return res.status(500).json({ error: "Evaluation failed" });
    }
  });
}
