const SUPABASE_URL = 'https://ubcgavzrlyadjyvykezt.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_iDH3ekWIKam64pJPZn1kgg_pLR8AmaL';

const hasSupabaseConfig = () => {
  return /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL)
    && SUPABASE_PUBLISHABLE_KEY
    && !SUPABASE_PUBLISHABLE_KEY.includes('COLE_AQUI');
};

const supabaseClient = hasSupabaseConfig()
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
  : null;
