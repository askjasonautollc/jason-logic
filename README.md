# Ask Jason Auto – Core Plan Backend

This repo contains the backend API that powers the Core Plan vehicle evaluation engine for Ask Jason Auto.

### Endpoint
`/api/submitEvaluation`

### Features
- Secure call to OpenAI Assistants API
- Accepts form inputs + up to 2 images
- Returns structured flip/buy/sell reports
- Role-aware (buyer, seller, flipper)

### Environment Variables (Set in Vercel)
- `OPENAI_API_KEY`
- `OPENAI_ASSISTANT_ID`
