
// submitEvaluation.js
// Vercel API with Cheerio HTML scraping, OpenAI threading, and timeouts/short-circuit for URL-only

import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { logTraffic } from "../logTraffic.js";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";

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

    const rawOutput = await runFullEvaluationLogic(floppy, files);

let parsed;
try {
  parsed = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
} catch (err) {
  console.error("❌ Failed to parse assistant output:", err.message);
  parsed = { error: "Malformed GPT response", raw: rawOutput };
}

// 🚨 Make sure you still log cleanly
await logTraffic({
  endpoint: req.url,
  method: req.method,
  statusCode: 200,
  request: floppy,
  response: parsed,
  session_id: '',
  user_agent: req.headers['user-agent'],
  ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress
});

return res.status(200).json(parsed);


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
const buildUserPrompt = (fields, files) => `
Evaluate this vehicle:

- Role: ${fields.role}
- Repair Skill: ${fields.repairSkill}
- Year: ${fields.year}
- Make: ${fields.make}
- Model: ${fields.model}
- Mileage: ${fields.mileage}
- Price: $${fields.price}
- ZIP Code: ${fields.zip}
- VIN: ${fields.vin || 'Not provided'}
- Notes: ${fields.conditionNotes}
${files?.length > 0 ? `- Images: ${files.length} photo(s) uploaded` : '- Images: None'}
`.trim();

async function runFullEvaluationLogic(fields, files) {
  const { vin, role, repairSkill, zip, make, model, year, mileage, price, conditionNotes } = fields;

  const userPrompt = buildUserPrompt(fields, files);

  const messages = [
    { role: "user", content: userPrompt }
  ];

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
  
// BEGIN GPT EVALUATION FLOW
const thread = await openai.beta.threads.create();

// Step 1: Send primary evaluation prompt
await openai.beta.threads.messages.create(thread.id, {
  role: "user",
  content: userPrompt
});

// Step 2: Process and attach up to 2 images (if any)
const uploadFileIds = [];
let uploadFiles = [];

if (files.photos) {
  uploadFiles = Array.isArray(files.photos) ? files.photos : [files.photos];
}

console.log("📸 Processing uploaded files:", uploadFiles.map(f => ({
  name: f.originalFilename,
  path: f.filepath,
  size: f.size,
  type: f.mimetype
})));

for (const photo of uploadFiles.slice(0, 2)) {
  if (photo && photo.size > 0 && photo.mimetype?.startsWith("image/")) {
    try {
      const buffer = fs.readFileSync(photo.filepath);
      if (!buffer || buffer.length === 0) {
        console.warn("⚠️ Skipping empty buffer:", photo.originalFilename);
        continue;
      }

      const ext = path.extname(photo.originalFilename || ".jpg") || ".jpg";
      const tempFileName = `${uuidv4()}${ext}`;
      const tempPath = path.join(os.tmpdir(), tempFileName);

      fs.writeFileSync(tempPath, buffer);
      const stream = fs.createReadStream(tempPath);

      const fileRec = await openai.files.create({
        file: stream,
        purpose: "assistants"
      });

      console.log("✅ File uploaded to OpenAI:", {
        id: fileRec.id,
        name: fileRec.filename,
        bytes: fileRec.bytes
      });

      uploadFileIds.push(fileRec.id);
    } catch (err) {
      console.error("❌ Exception uploading image:", {
        file: photo.originalFilename,
        message: err.message
      });
    }
  } else {
    console.warn("⚠️ Invalid or empty image skipped:", photo?.originalFilename || "unknown");
  }
}

const imageInstructions = `
---

🖼️ IMAGE INTELLIGENCE SECTION:
Review the attached vehicle image(s) and generate a dedicated section labeled exactly:
**🖼️ Image Intelligence**

Instructions:
- Do NOT assume the car is clean. Inspect it like you suspect damage.
- Report: trim (if visible), visible damage (dents, cracks), dash lights, shady details, interior wear, location clues.
- This should be a standalone section, BEFORE 'Jason’s Real Talk'.`;

console.log("🧠 Creating assistant message with combined prompt and images:", uploadFileIds);

const messagePayload = {
  role: "user",
  content: userPrompt + (uploadFileIds.length ? "\n\n" + imageInstructions : "")
};

if (uploadFileIds.length) {
  messagePayload.attachments = uploadFileIds.map(id => ({
    file_id: id,
    tools: [{ type: "code_interpreter" }]
  }));
}

await openai.beta.threads.messages.create(thread.id, messagePayload);

// Now run
const run = await openai.beta.threads.runs.create(thread.id, {
  assistant_id: process.env.OPENAI_ASSISTANT_ID,
  tool_choice: "auto"
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

// Sort oldest to newest to preserve reply order
const allAssistantMsgs = msgs.data
  .filter(m => m.role === "assistant")
  .sort((a, b) => a.created_at - b.created_at)
  .map(m => {
    const contentBlock = m.content?.find(c => c.type === "text");
    return contentBlock?.text?.value || "";
  })
  .filter(Boolean);

let report = allAssistantMsgs.join("\n\n").trim() || "No report generated.";

// 🧹 Strip markdown fencing if present
if (report.startsWith("```json")) {
  report = report.replace(/^```json/, "").replace(/```$/, "").trim();
}

let parsedReport;
try {
  parsedReport = JSON.parse(report);
} catch (e) {
  console.error("❌ Failed to parse assistant response:", e.message);
  parsedReport = { error: "Malformed JSON in assistant reply", raw: report };
}

return parsedReport;
}
