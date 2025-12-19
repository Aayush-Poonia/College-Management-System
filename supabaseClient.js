// Simple Supabase client setup for usage from browser modules or inline scripts.
// 1. In Supabase dashboard, go to Settings -> API.
// 2. Copy your project URL and anon public key and paste them below.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Supabase project configuration
// These values are safe to expose in a browser app (publishable anon key).
const SUPABASE_URL = 'https://vpcpclszokaxfqsdlpyw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_jo0brwXqeuQp4YxCdLwwTw_xU8DpLad';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


