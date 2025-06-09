import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const { make, model, year } = req.query;

  if (!make || !model || !year) {
    return res.status(400).json({ error: "Missing make, model, or year" });
  }

  const dataDir = path.join(process.cwd(), 'data');

  const allChunks = ['recalls-part-1.json', 'recalls-part-2.json', 'recalls-part-3.json'];
  let recalls = [];

  try {
    for (const file of allChunks) {
      const raw = fs.readFileSync(path.join(dataDir, file), 'utf8');
      recalls = recalls.concat(JSON.parse(raw));
    }

    const results = recalls.filter(r =>
      r["Recall Description"]?.toLowerCase().includes(make.toLowerCase()) &&
      r["Recall Description"]?.toLowerCase().includes(model.toLowerCase()) &&
      r["Recall Description"]?.includes(year)
    );

    res.status(200).json({ count: results.length, results });

  } catch (err) {
    res.status(500).json({ error: 'Failed to load recall data.', details: err.message });
  }
}
