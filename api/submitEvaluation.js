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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const form = formidable({ multiples: true, allowEmptyFiles: true, minFileSize: 0 });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "Form parse error" });

    try {
      const assistantId = process.env.OPENAI_ASSISTANT_ID;
      const flatten = (v) => Array.isArray(v) ? v[0] : v;

      const year = flatten(fields.year);
      const make = flatten(fields.make);
      const model = flatten(fields.model);
      const price = flatten(fields.listingURL)?.match(/\$\d[\d,]*/) || "N/A";
      const zip = flatten(fields.zip);
      const notes = flatten(fields.conditionNotes);
      const role = flatten(fields.role);
      const repairSkill = flatten(fields.repairSkill);
      const photosNote = files.photos ? "Provided" : "Not provided";

      const userInput = `
        Role: ${role}
        Repair Skill: ${repairSkill}
        Year: ${year}
        Make: ${make}
        Model: ${model}
        ZIP Code: ${zip}
        Notes: ${notes}
        Listing URL: ${fields.listingURL}
      `.trim();

      const thread = await openai.beta.threads.create();

      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: userInput,
      });

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
      const assistantMessage = messages.data.find(msg => msg.role === "assistant");
      const messageContent = assistantMessage?.content?.find(c => c.type === "text");

      if (!messageContent || !messageContent.text?.value) {
        return res.status(200).json({
          reportHtml: "<div class='text-yellow-400'>⚠️ Assistant did not return any readable text.</div>"
        });
      }

      const rawText = messageContent.text.value;

      // Extract common sections
      const extract = (label) => {
        const match = rawText.match(new RegExp(`${label}[^#]*`, 'i'));
        return match ? match[0].trim() : null;
      };

      const topRisks = extract("Top 5 Known Issues");
      const checklist = extract("Checklist");
      const buyerMath = extract("Buyer Math");
      const jasonsTake = extract("Jason.*Would Move");

      const formatBlock = (title, content, type = "div") =>
        content ? `<section class="bg-gray-800 rounded-xl p-6 shadow-md">
          <h2 class="text-lime-400 text-lg font-semibold mb-3">${title}</h2>
          <${type} class="text-sm text-gray-300 leading-relaxed whitespace-pre-line">${content.trim()}</${type}>
        </section>` : "";

      const reportHtml = `
        <div class="space-y-8 text-sm text-gray-300 leading-relaxed">
          <section class="bg-gray-800 rounded-xl p-6 shadow-md">
            <h2 class="text-lime-400 text-lg font-semibold mb-3">📊 Evaluation Summary</h2>
            <p class="text-white font-semibold text-base mb-1">${year} ${make} ${model} – ${price}</p>
            <p class="text-gray-400 text-sm">${zip} • ${notes}</p>
          </section>

          ${formatBlock("🚨 Top 5 Known Issues + Repair Risk", topRisks)}
          ${formatBlock("✅ Checklist (Tailored Per Car)", checklist)}
          ${formatBlock("📉 Buyer Math", buyerMath, 'pre')}
          ${formatBlock("🧠 Jason’s Real Talk", jasonsTake)}
        </div>
      `;

      return res.status(200).json({ reportHtml });
    } catch (e) {
      console.error("❌ Evaluation error:", e);
      return res.status(500).json({ error: "Evaluation failed" });
    }
  });
}
