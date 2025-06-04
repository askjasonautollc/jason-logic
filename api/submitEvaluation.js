import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  // ✅ CORS Headers for Webflow/API access
  res.setHeader("Access-Control-Allow-Origin", "*"); // Use exact origin in prod: https://askjasonauto.com
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // Preflight check
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = formidable({
    multiples: true,
    allowEmptyFiles: true,
    minFileSize: 0,
  });

  form.parse(req, async (err, fields, files) => {
    console.log("📥 Incoming request to /submitEvaluation");

    if (err) {
      console.error("❌ Form parse error:", err);
      return res.status(500).json({ error: "Form parse error" });
    }

    console.log("✅ Parsed fields:", fields);
    console.log("📎 Parsed files:", files);

    try {
      const assistantId = process.env.OPENAI_ASSISTANT_ID;

      const userInput = `
        Role: ${fields.role}
        Repair Skill: ${fields.repairSkill}
        Year: ${fields.year}
        Make: ${fields.make}
        Model: ${fields.model}
        ZIP Code: ${fields.zip}
        Notes: ${fields.conditionNotes}
        Listing URL: ${fields.listingURL}
      `;

      console.log("🧠 Prompt being sent:", userInput);

      const thread = await openai.beta.threads.create();
      console.log("🧵 Thread created:", thread.id);

      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: userInput,
      });

      if (files.photos) {
        let uploads = Array.isArray(files.photos) ? files.photos : [files.photos];
        uploads = uploads.slice(0, 2);
        uploads = uploads.filter(file => file && file.size > 0 && file.mimetype?.startsWith("image/"));

        console.log(`📸 Uploading ${uploads.length} photo(s)...`);

        for (const photo of uploads) {
          const fileStream = fs.createReadStream(photo.filepath);
          const uploadedFile = await openai.files.create({
            file: fileStream,
            purpose: "assistants",
          });

          await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            file_ids: [uploadedFile.id],
            content: "Attached vehicle photo for evaluation.",
          });

          console.log("✅ File uploaded:", uploadedFile.id);
        }
      }

      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });
      console.log("🚀 Assistant run started:", run.id);

      let runStatus;
      do {
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        console.log("⏳ Waiting... status:", runStatus.status);
        await new Promise(r => setTimeout(r, 2000));
      } while (runStatus.status !== "completed");

      const messages = await openai.beta.threads.messages.list(thread.id);
      const report = messages.data[0].content[0].text.value;

      console.log("✅ Report generated.");
      return res.status(200).json({ report });

    } catch (e) {
      console.error("❌ Error in evaluation process:", e);
      return res.status(500).json({ error: "Evaluation failed." });
    }
  });
}
