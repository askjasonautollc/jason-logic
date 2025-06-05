import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";
import { logTraffic } from "../logTraffic.js"; // fixed path and extension

// Disable body parsing (handled by formidable)
export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
      await logTraffic({
        endpoint: req.url,
        method: req.method,
        statusCode: 500,
        request: {},
        response: { error: "Form parse error" },
        req
      });
      return res.status(500).json({ error: "Form parse error" });
    }

    try {
      const assistantId = process.env.OPENAI_ASSISTANT_ID;

      const {
        role,
        repairSkill,
        year,
        make,
        model,
        zip,
        conditionNotes,
        listingURL
      } = flatFields;

      const userInput = `
        Role: ${role}
        Repair Skill: ${repairSkill}
        Year: ${year}
        Make: ${make}
        Model: ${model}
        ZIP Code: ${zip}
        Notes: ${conditionNotes}
        Listing URL: ${listingURL}
      `.trim();

      const thread = await openai.beta.threads.create();

      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: userInput,
      });

      if (files.photos) {
        let uploads = Array.isArray(files.photos) ? files.photos : [files.photos];
        uploads = uploads.slice(0, 2).filter(file =>
          file && file.size > 0 && file.mimetype?.startsWith("image/")
        );

        for (const photo of uploads) {
          const fileStream = fs.createReadStream(photo.filepath);
          const uploadedFile = await openai.files.create({
            file: fileStream,
            purpose: "assistants",
          });

          await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: "Attached vehicle photo for review.",
            attachments: [{
              file_id: uploadedFile.id,
              tools: [{ type: "code_interpreter" }]
            }],
          });
        }
      }

      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });

      let runStatus;
      let retries = 0;
      const maxRetries = 15;

      do {
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        if (runStatus.status === "completed") break;
        if (++retries > maxRetries) throw new Error("Timed out waiting for assistant response");
        await new Promise(r => setTimeout(r, 2000));
      } while (runStatus.status !== "completed");

      const messages = await openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data.find(msg => msg.role === "assistant");
      const markdown = lastMessage?.content?.[0]?.text?.value || "No report generated.";

      await logTraffic({
        endpoint: req.url,
        method: req.method,
        statusCode: 200,
        request: flatFields,
        response: { report: markdown },
        session_id: flatFields.session_id,
        req
      });

      return res.status(200).json({ report: markdown });

    } catch (e) {
      console.error("❌ Evaluation error:", e);

      await logTraffic({
        endpoint: req.url,
        method: req.method,
        statusCode: 500,
        request: flatFields,
        response: { error: e.message },
        session_id: flatFields.session_id,
        req
      });

      return res.status(500).json({ error: "Evaluation failed" });
    }
  });
}
