import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";

// Prevents Next.js from parsing body (we use formidable instead)
export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  // CORS headers for Webflow/Frontend POST
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const form = formidable({ multiples: true, allowEmptyFiles: true, minFileSize: 0 });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Form parse error:", err);
      return res.status(500).json({ error: "Form parse error" });
    }

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
      `.trim();

      // Step 1: Start thread
      const thread = await openai.beta.threads.create();

      // Step 2: Initial user message
      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: userInput,
      });

      // Step 3: Attach up to 2 images if available
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
            attachments: [
              {
                file_id: uploadedFile.id,
                tools: [{ type: "code_interpreter" }],
              },
            ],
          });
        }
      }

      // Step 4: Run assistant
      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });

      // Step 5: Poll until complete
      let runStatus;
      let retries = 0;
      const maxRetries = 15;

      do {
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        if (runStatus.status === "completed") break;

        if (++retries > maxRetries) {
          throw new Error("Timed out waiting for assistant response");
        }

        await new Promise((r) => setTimeout(r, 2000));
      } while (runStatus.status !== "completed");

      // Step 6: Get latest message from assistant
      const messages = await openai.beta.threads.messages.list(thread.id);
      const lastMessage = messages.data.find(msg => msg.role === "assistant");

      const report = lastMessage?.content?.[0]?.text?.value || "⚠️ No report returned.";

      return res.status(200).json({ report });

    } catch (e) {
      console.error("❌ Error in evaluation process:", e);
      return res.status(500).json({ error: "Evaluation failed." });
    }
  });
}
