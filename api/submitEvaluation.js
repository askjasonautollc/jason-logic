import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";
import fetch from "node-fetch";
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
  `You are Jason from Ask Jason Auto. The user is a ${role} with ${repairSkill} skill. This is a vehicle evaluation. Use logic to fill in missing data. You MUST:`,
  "- Estimate mileage if missing (15k/year).",
  "- Estimate private party value from known trends.",
  "- Estimate repair costs using common failures and user notes.",
  "- Always provide the maximum amount to pay based on the user's role:",
  "    - If Buyer: Calculate a clear 'Max Price to Pay' using comps, repairs, risk.",
  "    - If Flipper: Include margin math and 'Max Price to Pay' to hit 100% ROI.",
  "    - If Auction: Include buyer fee, tax/title, repairs, and return a 'Max Bid'.",
  "    - If Seller: Show max asking price based on comps and condition.",
  "- Use any section titled '🧠 External Search Results:' to identify comps, issues, or pricing data.",
  "- Include a separate section titled 'Internet Market Summary' that summarizes the most relevant takeaways from the search results.",
  "- If the verdict is WALK or RUN, and the user is a Buyer or Flipper, suggest 3 alternative make/model combinations under the same budget or risk profile.",
  "- ALWAYS include a 'How Jason Would Move' section: summarize the decision and exact action Jason would take in plain words (e.g., offer $1,000 cash or walk).",
  "- In the Money Math section, include total cost, resale value estimate, and net margin.",
  "- Do NOT suggest walking away due to recalls—list them, note fixability.",
  "- Always end with one verdict: ✅ TALK / 🚪 WALK / ❌ RUN.",
  "- Format in clean markdown tables with vertical bars and dividers.",
  "- Use '---' to break each section. NEVER omit the money breakdown.",
  "- Do NOT use any markdown headers like '#'. Use plain text only."
];

      const userInput = [
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
        ...systemPrimer
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
