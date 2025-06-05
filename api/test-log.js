import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  const { method, url, headers, body } = req;

  const responseData = { message: "Log received" };
  const statusCode = 200;

  await supabase.from('api_logs').insert({
    endpoint: url,
    method,
    request_body: body || {},
    response_body: responseData,
    status_code: statusCode,
    user_agent: headers['user-agent'],
    ip_address: headers['x-forwarded-for'] || req.socket?.remoteAddress
  });

  res.status(statusCode).json(responseData);
}
