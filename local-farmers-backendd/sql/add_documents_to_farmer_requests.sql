ALTER TABLE public.farmer_requests 
ADD COLUMN IF NOT EXISTS documents jsonb DEFAULT '{}'::jsonb;
