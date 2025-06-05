import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export async function logTraffic({ endpoint, method, statusCode, request, response, session_id, req }) {
  const flatRequest = {};
  for (const [key, val] of Object.entries(request || {})) {
    flatRequest[key] = Array.isArray(val) ? val[0] : val;
  }

  try {
    await supabase.from('api_logs').insert({
      endpoint,
      method,
      status_code: statusCode,
      request_body: flatRequest,
      response_body: response,
      user_agent: req?.headers?.['user-agent'] || null,
      ip_address: req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null,
      session_id
    });
  } catch (err) {
    console.error("❌ Failed to log traffic:", err.message);
  }
}
