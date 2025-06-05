import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export async function logTraffic({ endpoint, method, statusCode, request, response }) {
  try {
    await supabase.from('api_logs').insert({
      endpoint,
      method,
      status_code: statusCode,
      request_body: request,
      response_body: response,
      user_agent: request?.headers?.['user-agent'] || null,
      ip_address: request?.headers?.['x-forwarded-for'] || request?.socket?.remoteAddress || null
    });
  } catch (err) {
    console.error("❌ Failed to log traffic:", err.message);
  }
}
