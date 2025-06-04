import { OpenAI } from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false, // Required for file uploads
  },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = formidable({ multiples: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
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
      `;

      // Create GPT thread
      const thread = await openai.beta.threads.create();

      // Add the main message
      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: userInput,
      });

      // Handle uploaded photos (limit to 2)
      if (files.photos) {
        let uploads = Array.isArray(files.photos)
          ? files.photos
          : [files.photos];
        uploads = uploads.slice(0, 2); // Enforce max 2 photos

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
        }
      }

      // Run the assistant
      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });

      // Wait for response
      let runStatus;
      do {
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        await new Promise((r) => setTimeout(r, 2000));
      } while (runStatus.status !== "completed");

      // Get assistant message
      const messages = await openai.beta.threads.messages.list(thread.id);
      const report = messages.data[0].content[0].text.value;

      return res.status(200).json({ report });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Evaluation failed." });
    }
  });
}
